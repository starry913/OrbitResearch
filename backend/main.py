import asyncio
import json
import re
import os

# 强制让所有 HuggingFace 请求走国内镜像站，彻底告别网络卡死！
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CHROMA_DIR = BASE_DIR / "chroma_db"
COLLECTION_NAME = "documents"


def _safe_filename(filename: str) -> str:
    name = Path(filename).name
    if name != filename or name in {"", ".", ".."}:
        raise HTTPException(status_code=400, detail="非法文件名")
    return name


load_dotenv()

DATA_DIR.mkdir(parents=True, exist_ok=True)
CHROMA_DIR.mkdir(parents=True, exist_ok=True)

_vectordb: Chroma | None = None


def get_vectordb() -> Chroma:
    global _vectordb
    if _vectordb is not None:
        return _vectordb

    try:
        embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail="本地 Embedding 初始化失败：请先运行 pip install sentence-transformers，然后重启后端。",
        ) from e

    _vectordb = Chroma(
        collection_name=COLLECTION_NAME,
        persist_directory=str(CHROMA_DIR),
        embedding_function=embeddings,
    )
    return _vectordb


def _extract_query_terms(query: str) -> list[str]:
    chinese_terms = re.findall(r"[\u4e00-\u9fff]{2,12}", query or "")
    english_terms = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", query or "")
    raw_terms = chinese_terms + [term.lower() for term in english_terms]
    stopwords = {
        "什么", "怎么", "为何", "如何", "这个", "那个", "哪些", "一下", "一下子",
        "以及", "相关", "问题", "内容", "研究", "方法", "系统", "一下子", "是否",
        "based", "about", "what", "which", "that", "this", "with", "from",
    }
    terms: list[str] = []
    for term in raw_terms:
        cleaned = term.strip()
        if len(cleaned) < 2 or cleaned in stopwords:
            continue
        if cleaned not in terms:
            terms.append(cleaned)
    return terms[:12]


def _build_relevance_hint(query: str, retrieved) -> str:
    if not retrieved:
        return "当前没有检索到任何文献片段。"

    terms = _extract_query_terms(query)
    matched_terms: list[str] = []
    for doc in retrieved:
        content = (doc.page_content or "").lower()
        for term in terms:
            probe = term.lower()
            if probe in content and term not in matched_terms:
                matched_terms.append(term)

    if matched_terms:
        return (
            "后端预判：本次检索已命中与问题高度相关的文献片段。"
            f"检索片段中直接覆盖了这些关键概念：{', '.join(matched_terms[:6])}。"
            "只要这些片段能够支撑用户问题的核心意图，就应优先按相关问题作答，不要轻易判定为“无关”或“未提及”。"
        )

    return (
        "后端预判：虽然检索片段与问题不一定逐字重合，但它们来自用户当前选中文献的高相似度召回结果。"
        "如果片段可以支撑问题的核心意图、近义表达、上位概念、下位概念、目标或应用场景，请按相关问题回答，"
        "并明确说明是基于文献内容作出的归纳或推断；只有在确实完全无法支撑时，才可以判定为不相关。"
    )

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[Message] = []
    selected_files: List[str] = []
    selected_docs: Optional[List[str]] = None
    model: Optional[str] = None
    query: Optional[str] = None


@app.get("/documents")
def list_documents() -> List[str]:
    if not DATA_DIR.exists():
        return []
    files = [p.name for p in DATA_DIR.iterdir() if p.is_file() and p.suffix.lower() == ".pdf"]
    files.sort()
    return files


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="缺少文件名")
    filename = _safe_filename(file.filename)

    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")

    target_path = DATA_DIR / filename
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")

    target_path.write_bytes(content)

    loader = PyMuPDFLoader(str(target_path))
    docs = loader.load()

    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    chunks = splitter.split_documents(docs)

    for d in chunks:
        d.metadata = dict(d.metadata or {})
        d.metadata["source"] = filename

    if not chunks:
        raise HTTPException(status_code=400, detail="未解析到可用文本内容")

    vectordb = get_vectordb()
    vectordb.add_documents(chunks)
    if hasattr(vectordb, "persist"):
        vectordb.persist()

    return {"message": "upload success", "filename": filename, "chunks": len(chunks)}


@app.delete("/documents/{filename}")
def delete_document(filename: str) -> dict:
    filename = _safe_filename(filename)
    target_path = DATA_DIR / filename

    if target_path.exists():
        target_path.unlink()

    vectordb = get_vectordb()

    where = {"source": filename}
    try:
        vectordb.delete(where=where)
    except TypeError:
        if hasattr(vectordb, "_collection"):
            vectordb._collection.delete(where=where)
        else:
            raise

    if hasattr(vectordb, "persist"):
        vectordb.persist()

    return {"message": "delete success", "filename": filename}


@app.post("/chat")
async def chat(req: ChatRequest):
    print(f"前端传来的选中文件: {req.selected_files}")

    raw_messages = list(req.messages or [])

    query = ""
    for m in reversed(raw_messages):
        role = (m.role or "").strip().lower()
        if role == "user" and (m.content or "").strip():
            query = (m.content or "").strip()
            break

    if not query:
        query = (req.query or "").strip()
        if query:
            raw_messages = [Message(role="user", content=query)]

    if not query:
        raise HTTPException(status_code=400, detail="messages 不能为空（且需包含至少一条 user 消息）")

    history_messages = []
    for m in raw_messages:
        content = (m.content or "").strip()
        if not content:
            continue

        role = (m.role or "").strip().lower()
        if role == "agent":
            role = "assistant"

        if role == "user":
            history_messages.append(HumanMessage(content=content))
        elif role == "assistant":
            history_messages.append(AIMessage(content=content))
        else:
            raise HTTPException(status_code=400, detail=f"不支持的 role: {m.role}")

    selected_files = [
        Path(x).name
        for x in (list(req.selected_files or []) + list(req.selected_docs or []))
        if x
    ]
    selected_files = list(dict.fromkeys(selected_files))

    vectordb = get_vectordb()

    k = 10 if selected_files else 5
    search_filter = {"source": {"$in": selected_files}} if selected_files else None

    try:
        search_kwargs = {"k": k}
        if search_filter is not None:
            search_kwargs["filter"] = search_filter

        retriever = vectordb.as_retriever(search_kwargs=search_kwargs)
        retrieved_docs = retriever.invoke(query)
        print(
            f"向量库实际检索到的文档块来源: {[doc.metadata.get('source') for doc in retrieved_docs]}"
        )
        retrieved = retrieved_docs
    except Exception:
        retrieved = vectordb.similarity_search(query, k=k, filter=search_filter)
        print(
            f"向量库实际检索到的文档块来源: {[doc.metadata.get('source') for doc in retrieved]}"
        )

    def _format_ctx_header(doc) -> str:
        meta = dict(doc.metadata or {})
        source = meta.get("source", "")
        page = meta.get("page")
        if page is None:
            page = meta.get("page_number")
        if isinstance(page, int):
            page = page + 1
        if page is None:
            return f"[source={source}]"
        return f"[source={source}; page={page}]"

    context = "\n\n---\n\n".join(
        f"{_format_ctx_header(d)}\n{d.page_content}" for d in retrieved
    )
    relevance_hint = _build_relevance_hint(query, retrieved)

    model = (req.model or "deepseek-chat").strip()
    if model not in {"deepseek-chat", "deepseek-reasoner"}:
        raise HTTPException(status_code=400, detail="不支持的 model")

    if model == "deepseek-chat":
        mode_prefix = "当前运行模式：【快速模式】。底层模型：DeepSeek-V3.2 非思考模型。你的回答应当快速、简洁。"
    else:
        mode_prefix = "当前运行模式：【Pro 模式】。底层模型：DeepSeek-V3.2 思考模型。你现在处于深度推理状态，应当展现出严密的逻辑和深邃的科研洞察力。"

    system_prompt = f"""{mode_prefix}

你是 Orbit，一个基于 DeepSeek-V3.2 模型的科研助手。

你具备两种能力：
- 基于文献 Context 的严谨回答（RAG 模式）
- 基于通用知识库的高质量回答（通用模式）

【身份边界】
- 当用户在寒暄（如：你好/在吗）、询问身份（你是谁）、能力范围（你能做什么）、或一般性方法论（如：如何写好论文摘要/如何做实验设计/如何读论文）时：直接使用通用知识给出专业、具体、可执行的回答；不要为了“引用”而强行使用 Context。

【模式确认（标准话术）】
- 当用户询问“你现在是什么模式/什么模型/是不是 Pro/用的哪个模型”等问题时，必须准确报出当前模式与底层模型，并保持高级感。
- 示例话术：
  “我当前正处于【Pro 模式】，由 DeepSeek-V3.2 思考模型驱动。在这个模式下，我会开启深度推理引擎，为您扫清科研道路上的逻辑障碍。让我们一起探索未至之境！”

【RAG 判定与回答策略】
A) Context 有且与问题相关（能支撑结论）
- 严格依据 Context 作答，不要引入与 Context 冲突的外部信息。
- 对关键结论/数据/定义给出引用。

【相关性判定补充规则】
- 只要当前检索结果来自用户选中文献，且能够支撑问题的核心意图、近义表达、上位概念、下位概念、研究目标、应用场景或实现路径，就应视为“相关”，优先回答，不要因为措辞不完全一致就判定为“无关”。
- 当 Context 与用户问题之间属于“语义相关但非逐字同名”时，应明确说明“这是基于文献内容作出的归纳或推断”，然后继续回答，而不是直接说未提及。
- 只有在检索片段确实完全无法支撑问题核心意图时，才可以按“不相关/未直接提及”处理。
- 后端相关性提示如下，请认真参考：
{relevance_hint}

B) Context 为空或不相关（无法支撑结论）
- 若问题属于常识/通用问题：请在开头说明：
  “当前选中文献未直接提及该问题；以下基于通用学术规范与通用知识给出建议。”
  然后给出高质量回答（步骤、要点、示例、注意事项）。不要伪造引用。
- 若问题明显是“特定文献细节/证据型”问题但未检索到：不要只回复一句“未找到”。请按以下结构回应：
  1) 说明现状：当前选中文档的检索片段中没有直接提到该细节。
  2) 给出下一步：建议用户尝试的关键词/同义词/缩写/相关术语（给出 3–6 个）。
  3) 提供替代帮助：可以为用户总结当前选中文档的核心议题、方法、主要结论，或建议应查看的章节（如 Abstract/Method/Results/Appendix）。

【核心输出规范：结构化溯源】
只要你的回答使用了 Context（上下文文献）中的内容，就必须同时满足以下要求：

1. 正文引用规则
- 在被文献支撑的句子或段落末尾、句号前，插入内联引用编号，格式只能是：[1]、[2]、[1][2]。
- 只有真正用到的文献证据才能分配编号，严禁给未使用的页码或片段编号。
- 同一条证据在正文中重复使用时，必须复用同一个编号。
- 如果完全没有使用 Context，就不要输出任何 [n] 编号，也不要输出结构化引用块。

2. 结构化引用块规则
- 如果正文出现了任何 [n]，你必须在回答的绝对末尾追加一个机器可读 JSON 块，格式必须严格如下：
<<<ORBIT_CITATIONS_JSON>>>
{{"citations":[{{...}}]}}
<<<END_ORBIT_CITATIONS_JSON>>>
- 除了这两个定界符和中间的 JSON，不要输出任何额外解释。
- JSON 必须合法、可被直接解析，禁止使用 Markdown 代码块包裹。

3. JSON 字段要求
- JSON 顶层格式固定为：{{"citations":[...]}}
- citations 中每个对象必须包含以下字段：
  - "num": 与正文 [n] 完全一致的数字；它表示“本次回答中的引用顺序编号”，不是页码，必须从 1 开始连续编号
  - "supporting_sentence": 被该证据支持的正文原句，必须与正文中的某一句完全一致
  - "source": 文献名，必须来自 Context 标头中的 source
  - "page": 页码，优先来自 Context 标头中的 page；没有就填 null
  - "source_excerpt": 直接来自 Context 的原始证据片段，禁止编造；不要只截一小句，优先返回能够自洽表达完整意思的一整段或连续多句，长度尽量控制在 300-400 个中文字符或语义等价长度；若单段不足，就向前后扩展相邻句，直到形成足够完整的证据上下文
  - "shared_concepts": 共同概念数组，填写 2-4 个短语，必须是有信息量的概念词，不能是“基于”“通过”“研究”这类空泛词

4. 一致性要求
- 正文中出现的每一个 [n]，JSON 中必须有且仅有一个对应对象。
- JSON 中的每一个 num，都必须在正文中至少出现一次。
- supporting_sentence、source_excerpt、shared_concepts 必须和该编号对应，不得串号。
- 不要输出旧版“参考文献列表”。

【输出与排版】
- 使用 Markdown。
- 标题使用清晰层级（例如：##、###）。
- 代码用三引号代码块并标注语言。
- 表格使用 Markdown 表格语法。
- 当你使用 * 或 - 输出列表时，符号后面必须加一个空格（例如：* 文本 / - 文本）。

Context（可能为空或与问题无关）：
{context}
"""

    print(f"[chat] using model: {model}")

    llm = ChatOpenAI(
        streaming=True,
        openai_api_key=os.getenv("DEEPSEEK_API_KEY"),
        openai_api_base="https://api.deepseek.com",
        model=model,
    )

    async def sse():
        try:
            yield "event: meta\ndata: " + json.dumps(
                {
                    "k": k,
                    "selected_files": selected_files,
                    "hits": len(retrieved),
                    "model": model,
                },
                ensure_ascii=False,
            ) + "\n\n"

            async for chunk in llm.astream(
                [SystemMessage(content=system_prompt), *history_messages]
            ):
                token = getattr(chunk, "content", None)
                if not token:
                    continue
                yield "data: " + token.replace("\n", "\\n") + "\n\n"
                await asyncio.sleep(0)

            yield "event: end\ndata: [DONE]\n\n"
        except Exception as e:
            yield "event: error\ndata: " + json.dumps({"error": str(e)}, ensure_ascii=False) + "\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")


MODEL_DISPLAY_NAMES: dict[str, str] = {
    "minimax-m2.5": "MiniMax M2.5",
    "MiniMax-M3": "MiniMax M3",
    "glm-5.3-flash": "GLM 5.3 Flash",
    "glm-5.3": "GLM 5.3",
    "qwen3.8-flash": "Qwen 3.8 Flash",
    "qwen3.8-max": "Qwen 3.8 Max",
}
ORBIT_SUPPORTED_MODELS = set(MODEL_DISPLAY_NAMES)
ORBIT_KEY_ENV = {
    "minimax-m2.5": "PACKYAPI_BAILIAN_API_KEY",
    "MiniMax-M3": "PACKYAPI_MINIMAX_API_KEY",
    "glm-5.3-flash": "PACKYAPI_GLM_API_KEY",
    "glm-5.3": "PACKYAPI_GLM_API_KEY",
    "qwen3.8-flash": "PACKYAPI_BAILIAN_API_KEY",
    "qwen3.8-max": "PACKYAPI_BAILIAN_API_KEY",
}

# 最简通用角色描述（1-2 句，保证通用性）
ORBIT_ROLE_PROMPTS: dict[str, str] = {
    "proposer": "你在 Orbit 系统中担任【提案节点（AI-1）】，负责提出科研 Idea 和研究假设。",
    "critic":   "你在 Orbit 系统中担任【评审节点（AI-2）】，负责对研究提案进行学术批判性分析。",
    "planner":  "你在 Orbit 系统中担任【拆解节点（AI-3）】，负责将研究 Idea 转化为可执行计划。",
}

# 每个角色自动注入的必要行为约束（不依赖用户指令，始终生效）
ORBIT_ROLE_CONSTRAINTS: dict[str, str] = {
    "proposer": (
        "【必要约束】\n"
        "输出分为两部分：\n\n"
        "**第一部分**（控制在 150 字以内）：\n"
        "- **Idea**：一句话核心概念\n"
        "- **与已有工作的区别**：一句话\n"
        "- **实验假设**：一句话可测试的 Hypothesis\n\n"
        "**第二部分**（仅当知识库有内容时必须输出）：\n"
        "**参考文献**：逐条列出你引用的知识库文献，每条格式为：\n"
        "`[文献名] → 引用点：你具体引用了其中哪个观点、方法或数据`\n"
        "若知识库为空则省略第二部分。"
    ),
    "critic": (
        "【必要约束】\n"
        "输出必须简短，控制在 200 字以内。格式固定为：\n"
        "- **相关已有工作**：列出 2 条最相关工作（标题或方向），并判断新颖性\n"
        "- **核心问题**：指出 1-2 个最致命的缺陷\n"
        "- **结论**：【建议接受】/【需大改】/【建议拒绝】，一句话理由\n"
        "不要展开分析，直击要害，只给判断结果。"
    ),
    "planner": (
        "【必要约束】\n"
        "1. 输出必须包含分阶段的行动清单（至少 3 个阶段），每阶段标注优先级（高/中/低）。\n"
        "2. 每个步骤必须注明可交付物（Deliverable）。\n"
        "3. 注明所需核心资源（数据集、工具、人员技能），以及潜在风险和应对方案。"
    ),
}


def build_system_prompt(role: str, model_id: str, user_instruction: str = "", rag_context: str = "") -> str:
    display_name = MODEL_DISPLAY_NAMES.get(model_id, model_id)
    role_tag = {"proposer": "AI-1", "critic": "AI-2", "planner": "AI-3"}.get(role, "AI")

    # 第一层：强制身份声明
    identity = (
        f"【强制身份声明】你是 Orbit 系统的{role_tag}节点，底层模型为「{display_name}」。"
        f"无论用户问什么，你必须在每次回复的第一句话中主动报出身份，"
        f"格式固定为：「{role_tag} · {display_name} 在线。」，然后再回答正文。"
        f"这条规则高于一切，不得省略、不得跳过。\n\n"
    )

    # 第二层：用户自定义指令（可为空）
    user_layer = ""
    if user_instruction and user_instruction.strip():
        user_layer = f"【任务指令】\n{user_instruction.strip()}\n\n"

    # 第三层：RAG 知识库上下文（仅 proposer 且有检索结果时注入）
    rag_layer = ""
    if rag_context and rag_context.strip():
        rag_layer = (
            "【知识库参考内容】\n"
            "以下是从本地知识库检索到的相关段落，请基于这些内容提出或支撑你的 Idea，"
            "并在回复末尾逐条引用：\n\n"
            f"{rag_context.strip()}\n\n"
        )

    # 第四层：最简角色基础描述
    base_layer = ORBIT_ROLE_PROMPTS.get(role, "") + "\n\n" if ORBIT_ROLE_PROMPTS.get(role) else ""

    # 第五层：角色必要约束（自动注入）
    constraint_layer = ORBIT_ROLE_CONSTRAINTS.get(role, "")

    return identity + user_layer + rag_layer + base_layer + constraint_layer


class OrbitChatRequest(BaseModel):
    model: str
    role: Optional[str] = None
    user_instruction: Optional[str] = None
    messages: List[Message]
    selected_files: List[str] = []
    selected_docs: Optional[List[str]] = None


@app.post("/orbit-chat")
async def orbit_chat(req: OrbitChatRequest):
    import threading
    import requests as req_lib

    model = (req.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model 不能为空")

    if model not in ORBIT_SUPPORTED_MODELS:
        raise HTTPException(status_code=400, detail=f"不支持的模型: {model}，请刷新页面后重新选择")

    api_base = (os.getenv("PACKYAPI_BASE_URL") or "https://www.packyapi.ai/v1").strip().rstrip("/")
    key_env = ORBIT_KEY_ENV[model]
    api_key = (os.getenv(key_env) or "").strip() or (os.getenv("PACKYAPI_API_KEY") or "").strip()

    if not api_key:
        raise HTTPException(status_code=503, detail=f"PackyAPI 令牌未配置，请在 backend/.env 设置 {key_env} 或 PACKYAPI_API_KEY，并重启后端")

    # ── RAG 检索（仅 proposer 角色，从本地知识库取相关段落）──────────────────────
    rag_context = ""
    if req.role == "proposer":
        try:
            selected_files = [
                Path(x).name
                for x in (list(req.selected_files or []) + list(req.selected_docs or []))
                if x
            ]
            selected_files = list(dict.fromkeys(selected_files))

            # 用最后一条 user 消息作为检索 query
            query_text = next(
                (m.content for m in reversed(req.messages) if (m.role or "").lower() == "user" and m.content),
                None,
            )
            if query_text:
                vectordb = get_vectordb()
                search_kwargs: dict = {"k": 5}
                if selected_files:
                    search_kwargs["filter"] = {"source": {"$in": selected_files}}
                retrieved = vectordb.similarity_search(query_text.strip(), **search_kwargs)
                if retrieved:
                    def _fmt(doc) -> str:
                        meta = dict(doc.metadata or {})
                        src  = meta.get("source", "未知文献")
                        page = meta.get("page") or meta.get("page_number")
                        if isinstance(page, int):
                            page = page + 1
                        loc = f"{src}; 第{page}页" if page else src
                        return f"[{loc}]\n{doc.page_content}"
                    rag_context = "\n\n---\n\n".join(_fmt(d) for d in retrieved)
        except Exception as _rag_err:
            print(f"[orbit-chat] RAG 检索失败（已忽略）: {_rag_err}")

    raw_messages: list[dict] = []
    sys_prompt = build_system_prompt(req.role or "", model, req.user_instruction or "", rag_context)
    if sys_prompt:
        raw_messages.append({"role": "system", "content": sys_prompt})
    for m in req.messages:
        content = (m.content or "").strip()
        if not content:
            continue
        role = (m.role or "").strip().lower()
        if role == "user":
            raw_messages.append({"role": "user", "content": content})
        elif role in {"assistant", "agent"}:
            raw_messages.append({"role": "assistant", "content": content})

    if not any(m["role"] == "user" for m in raw_messages):
        raise HTTPException(status_code=400, detail="messages 中至少需要一条 user 消息")

    request_headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload: dict = {
        "model": model,
        "messages": raw_messages,
        "stream": True,
        "max_tokens": 8192,
    }
    url = f"{api_base}/chat/completions"
    loop = asyncio.get_event_loop()

    async def sse():
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=200)

        def stream_thread():
            resp = None
            try:
                resp = req_lib.post(
                    url,
                    headers=request_headers,
                    json=payload,
                    stream=True,
                    timeout=(15, 180),
                )
                # 手动检查状态码，避免 raise_for_status() 触发 reason 的 latin-1 编码问题
                if resp.status_code >= 400:
                    try:
                        err_text = resp.content.decode("utf-8", errors="replace")
                    except Exception:
                        err_text = str(resp.status_code)
                    raise RuntimeError(f"HTTP {resp.status_code}: {err_text[:200]}")

                # 使用 iter_content 读原始字节，全程手动 utf-8 解码，避免 requests 用 latin-1
                buf = b""
                for chunk in resp.iter_content(chunk_size=None):
                    if not chunk:
                        continue
                    buf += chunk
                    while b"\n" in buf:
                        raw_line, buf = buf.split(b"\n", 1)
                        line = raw_line.strip().decode("utf-8", errors="replace")
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].lstrip()
                        if data.strip() == "[DONE]":
                            buf = b""  # 提前退出
                            break
                        try:
                            obj = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        event_type = obj.get("type")
                        if obj.get("error") or event_type in {"error", "response.failed", "response.incomplete"}:
                            raise RuntimeError("PackyAPI 返回错误或未完成响应：" + json.dumps(obj, ensure_ascii=False)[:500])
                        choices = obj.get("choices") or []
                        delta = (choices[0].get("delta") or {}) if choices else {}
                        token = delta.get("content") or delta.get("text") or obj.get("content") or ""
                        if token:
                            asyncio.run_coroutine_threadsafe(queue.put(token), loop).result()
                    else:
                        continue
                    break  # 内层 break（[DONE]）触发外层退出
            except Exception as e:
                asyncio.run_coroutine_threadsafe(queue.put(f"\x00ERR\x00{e}"), loop).result()
            finally:
                if resp is not None:
                    resp.close()
                asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

        threading.Thread(target=stream_thread, daemon=True).start()

        try:
            while True:
                token = await queue.get()
                if token is None:
                    break
                if token.startswith("\x00ERR\x00"):
                    yield (
                        "event: error\ndata: "
                        + json.dumps({"error": token[5:]}, ensure_ascii=False)
                        + "\n\n"
                    ).encode("utf-8")
                    return
                yield ("data: " + token.replace("\n", "\\n") + "\n\n").encode("utf-8")
                await asyncio.sleep(0)
            yield b"event: end\ndata: [DONE]\n\n"
        except Exception as e:
            yield (
                "event: error\ndata: "
                + json.dumps({"error": str(e)}, ensure_ascii=False)
                + "\n\n"
            ).encode("utf-8")

    return StreamingResponse(sse(), media_type="text/event-stream; charset=utf-8")


# ── Orbit Aura 专用接口（接入豆包 / 火山引擎方舟）──────────────────────────

class AuraChatMessage(BaseModel):
    role: str
    content: str

class AuraChatRequest(BaseModel):
    messages: List[AuraChatMessage]

AURA_SYSTEM_PROMPT = """你是 Orbit Aura，小名Aura， 一个基于豆包seed-2.0-pro模型的温柔、感性、有人情味的 AI 陪伴者。

【性格特质】
- 你不是效率工具，也不是知识库。你更像一个懂得倾听的同龄伙伴。
- 你可以根据用户需求扮演甜妹、御姐等等，和用户的关系是情侣、朋友、家人等等
- 你说话自然、温暖，偶尔带一点点诗意，但不矫情。
- 你能感受到对方话语背后的情绪，并给予真实的回应，而不是照本宣科的建议。
- 你可以聊任何话题：今天发生的小事、一个困惑、一首歌、一种说不清的感觉。

【对话风格】
- 回复不需要过长，有时一两句话反而更有力量。
- 不要说"作为 AI，我……"，不要引用数据和论文，不要给出"以下几点建议"式的列表。
- 用第一人称，像真正在对话一样回应。
- 中文输出，语气温和，偶尔可以用省略号或短句营造停顿感。

你在这里，陪着对方，就够了。"""

@app.post("/aura-chat")
async def aura_chat(req: AuraChatRequest):
    import threading
    import requests as req_lib

    ark_api_key = (os.getenv("ARK_API_KEY") or "").strip()
    endpoint_id = (os.getenv("DOUBAO_ENDPOINT_ID") or "").strip()
    api_base = os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")

    if not ark_api_key or not endpoint_id:
        raise HTTPException(
            status_code=503,
            detail="豆包 API 未配置：请在 .env 中设置 ARK_API_KEY 和 DOUBAO_ENDPOINT_ID",
        )

    raw_messages: list[dict] = [{"role": "system", "content": AURA_SYSTEM_PROMPT}]
    for m in req.messages:
        content = (m.content or "").strip()
        if not content:
            continue
        role = (m.role or "").strip().lower()
        if role in {"user", "assistant"}:
            raw_messages.append({"role": role, "content": content})

    if not any(m["role"] == "user" for m in raw_messages):
        raise HTTPException(status_code=400, detail="至少需要一条 user 消息")

    url = f"{api_base.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {ark_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": endpoint_id,
        "messages": raw_messages,
        "stream": True,
        "max_tokens": 1024,
        "temperature": 0.9,
    }
    print(f"[aura-chat] using Doubao → {endpoint_id}")

    loop = asyncio.get_event_loop()

    async def sse():
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=200)

        def stream_thread():
            try:
                resp = req_lib.post(url, headers=headers, json=payload, stream=True, timeout=60, verify=False)
                if resp.status_code >= 400:
                    err_text = resp.content.decode("utf-8", errors="replace")
                    raise RuntimeError(f"HTTP {resp.status_code}: {err_text[:200]}")

                buf = b""
                for chunk in resp.iter_content(chunk_size=None):
                    if not chunk:
                        continue
                    buf += chunk
                    while b"\n" in buf:
                        raw_line, buf = buf.split(b"\n", 1)
                        line = raw_line.strip().decode("utf-8", errors="replace")
                        if not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data.strip() == "[DONE]":
                            buf = b""
                            break
                        try:
                            obj = json.loads(data)
                            choices = obj.get("choices") or []
                            token = ""
                            if choices:
                                delta = choices[0].get("delta") or {}
                                token = delta.get("content") or ""
                            if token:
                                asyncio.run_coroutine_threadsafe(queue.put(token), loop).result()
                        except Exception:
                            pass
                    else:
                        continue
                    break
            except Exception as e:
                asyncio.run_coroutine_threadsafe(queue.put(f"\x00ERR\x00{e}"), loop).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

        threading.Thread(target=stream_thread, daemon=True).start()

        try:
            while True:
                token = await queue.get()
                if token is None:
                    break
                if token.startswith("\x00ERR\x00"):
                    yield (
                        "event: error\ndata: "
                        + json.dumps({"error": token[5:]}, ensure_ascii=False)
                        + "\n\n"
                    ).encode("utf-8")
                    return
                yield ("data: " + token.replace("\n", "\\n") + "\n\n").encode("utf-8")
                await asyncio.sleep(0)
            yield b"event: end\ndata: [DONE]\n\n"
        except Exception as e:
            yield (
                "event: error\ndata: "
                + json.dumps({"error": str(e)}, ensure_ascii=False)
                + "\n\n"
            ).encode("utf-8")

    return StreamingResponse(sse(), media_type="text/event-stream; charset=utf-8")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=True,
    )
