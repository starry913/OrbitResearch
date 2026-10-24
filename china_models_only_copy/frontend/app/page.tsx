"use client";

 import { AnimatePresence, motion, useAnimation } from "framer-motion";
import { useRouter } from "next/navigation";
import { FileText, LoaderCircle, Plus, Send, Upload, Trash2, Copy, Check, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { diffWords } from "diff";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { flushSync } from "react-dom";

type Message = {
  id: string;
  role: "assistant" | "user" | "agent";
  content: string;
  title?: string;
  citationCards?: CitationCard[];
};

type CitationCard = {
  num: number;
  supporting_sentence: string;
  source: string;
  page?: number | null;
  source_excerpt: string;
  shared_concepts: string[];
};

type SelectedEvidence = {
  messageId: string;
  refNum: number;
  status: "loading" | "ready";
  card?: CitationCard;
};

type ParsedCitationResult = {
  content: string;
  citationCards: CitationCard[];
  citationBlockStarted: boolean;
  citationBlockComplete: boolean;
};

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const bubbleMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 10 },
  transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
};

const API_BASE = "http://localhost:8000";

const MODEL_OPTIONS = {
  speed: { title: "快速", desc: "快速回答", id: "deepseek-chat" },
  pro: { title: "Pro", desc: "深度科研与精准溯源", id: "deepseek-reasoner" },
} as const;

type ModelKey = keyof typeof MODEL_OPTIONS;

type SseEvent = { event: string; data: string };

function extractSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: SseEvent[] = [];

  for (const part of parts) {
    const lines = part.split("\n").filter(Boolean);
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }

    events.push({ event, data: dataLines.join("\n") });
  }

  return { events, rest };
}

const preprocessMarkdown = (text: string) => {
  if (!text) return "";
  let processed = text;

  // 1. Fix headings without space: ##Title → ## Title
  processed = processed.replace(/^(#{1,6})(?![\s#])/gm, "$1 ");

  // 2. Fix unspaced `-` bullet: -text → - text
  processed = processed.replace(/^(-)(?![- \t])/gm, "- ");

  // 3. Fix unspaced `*` bullet at line start — ONLY when there is no closing `*`
  //    on the same line (otherwise it's inline emphasis like *text*, not a bullet)
  processed = processed.replace(/^(\*)(?![* \t])(?![^\n]*\*)/gm, "* ");

  // 4. Convert paired single-asterisk *text* → **text** (bold)
  //    remark sometimes fails to parse *CJK text*：(followed by fullwidth punctuation)
  //    as emphasis due to CommonMark's flanking-delimiter rules.
  //    Pre-converting to double-asterisk bypasses that parser edge case entirely.
  //    Guard: not preceded or followed by another `*` (avoid touching **bold** already)
  processed = processed.replace(/(?<!\*)\*([^\n*]+?)\*(?!\*)/g, "**$1**");

  // 5. Ensure a blank line before list items so the parser treats them as a list
  processed = processed.replace(/([^\n])\n([*\-] )/g, "$1\n\n$2");

  return processed;
};

const processContent = (text: string) => {
  if (!text) return "";
  return text.replace(/(?<!\[)\[(\d+)\](?!\]|\()(?!\s*《)/g, "[$1](#ref-$1)");
};

const CITATION_BLOCK_START = "<<<ORBIT_CITATIONS_JSON>>>";
const CITATION_BLOCK_END = "<<<END_ORBIT_CITATIONS_JSON>>>";

function normalizeCitationCard(raw: unknown): CitationCard | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  const num = Number(obj.num);
  const supportingSentence = typeof obj.supporting_sentence === "string" ? obj.supporting_sentence.trim() : "";
  const source = typeof obj.source === "string" ? obj.source.trim() : "";
  const sourceExcerpt = typeof obj.source_excerpt === "string" ? obj.source_excerpt.trim() : "";
  const page =
    typeof obj.page === "number"
      ? obj.page
      : typeof obj.page === "string" && obj.page.trim()
        ? Number(obj.page)
        : null;
  const sharedConcepts = Array.isArray(obj.shared_concepts)
    ? obj.shared_concepts.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];

  if (!Number.isFinite(num) || num <= 0 || !supportingSentence || !source || !sourceExcerpt) {
    return null;
  }

  return {
    num,
    supporting_sentence: supportingSentence,
    source,
    page: Number.isFinite(page) ? page : null,
    source_excerpt: sourceExcerpt,
    shared_concepts: Array.from(new Set(sharedConcepts)),
  };
}

function renumberCitationResult(content: string, citationCards: CitationCard[]): { content: string; citationCards: CitationCard[] } {
  if (!content) {
    return { content, citationCards };
  }

  const oldNumsInOrder: number[] = [];
  for (const match of content.matchAll(/(?<!\[)\[(\d+)\](?!\])/g)) {
    const num = Number(match[1]);
    if (!Number.isFinite(num) || oldNumsInOrder.includes(num)) continue;
    oldNumsInOrder.push(num);
  }

  if (oldNumsInOrder.length === 0) {
    return { content, citationCards };
  }

  const cardByNum = new Map<number, CitationCard>();
  citationCards.forEach((card) => {
    cardByNum.set(card.num, card);
  });

  const oldToNew = new Map<number, number>();
  oldNumsInOrder.forEach((oldNum, index) => {
    oldToNew.set(oldNum, index + 1);
  });

  const renumberedContent = content.replace(
    /(?<!\[)\[(\d+)\](?!\])/g,
    (_match, rawNum: string) => `[${oldToNew.get(Number(rawNum)) ?? Number(rawNum)}]`,
  );

  const renumberedCards =
    citationCards.length === 0
      ? []
      : oldNumsInOrder
          .map((oldNum) => {
            const card = cardByNum.get(oldNum);
            if (!card) return null;
            return { ...card, num: oldToNew.get(oldNum) ?? oldNum };
          })
          .filter((item): item is CitationCard => item !== null);

  return { content: renumberedContent, citationCards: renumberedCards };
}

function splitAnswerAndCitationPayload(raw: string): ParsedCitationResult {
  if (!raw) {
    return { content: "", citationCards: [], citationBlockStarted: false, citationBlockComplete: false };
  }

  const start = raw.indexOf(CITATION_BLOCK_START);
  if (start === -1) {
    const renumbered = renumberCitationResult(raw, []);
    return { content: renumbered.content, citationCards: [], citationBlockStarted: false, citationBlockComplete: false };
  }

  const content = raw.slice(0, start).trimEnd();
  const end = raw.indexOf(CITATION_BLOCK_END, start + CITATION_BLOCK_START.length);

  // Streaming 过程中只要已经出现了结构化引用起始标记，就立刻把后半段隐藏，
  // 避免未接收完成的 JSON 暴露在正文里。
  if (end === -1 || end < start) {
    const renumbered = renumberCitationResult(content, []);
    return { content: renumbered.content, citationCards: [], citationBlockStarted: true, citationBlockComplete: false };
  }

  const jsonText = raw.slice(start + CITATION_BLOCK_START.length, end).trim();

  try {
    const parsed = JSON.parse(jsonText) as { citations?: unknown[] };
    const citationCards = Array.isArray(parsed.citations)
      ? parsed.citations.map(normalizeCitationCard).filter((item): item is CitationCard => item !== null)
      : [];
    const renumbered = renumberCitationResult(content, citationCards);

    return {
      content: renumbered.content,
      citationCards: renumbered.citationCards,
      citationBlockStarted: true,
      citationBlockComplete: true,
    };
  } catch {
    return { content, citationCards: [], citationBlockStarted: true, citationBlockComplete: false };
  }
}

function stripCitationPayload(raw: string): string {
  if (!raw) return "";

  const start = raw.indexOf(CITATION_BLOCK_START);
  if (start === -1) return raw.trim();

  return raw.slice(0, start).trimEnd();
}

function OrbitLogo({ size = 36, animated = false }: { size?: number; animated?: boolean }) {
  const uid = useId();
  const orbitStrokeId = `orbitStroke-${uid}`;
  const orbitSphereId = `orbitSphere-${uid}`;

  const orbitPath = "M 56 32 A 24 16 -25 1 1 8 32 A 24 16 -25 1 1 56 32";

  const satelliteStyle: React.CSSProperties = {
    filter: "drop-shadow(0 0 8px rgba(255,255,255,0.95)) drop-shadow(0 0 14px rgba(59,130,246,0.55))",
  };

  return (
    <div
      className="relative flex-shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        filter:
          "drop-shadow(0 0 10px rgba(59,130,246,.55)) drop-shadow(0 0 18px rgba(139,92,246,.28))",
      }}
    >
      <svg viewBox="0 0 64 64" className="absolute inset-0">
        <defs>
          <linearGradient id={orbitStrokeId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2563eb" />
            <stop offset="0.6" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#db2777" />
          </linearGradient>
          <radialGradient id={orbitSphereId} cx="30%" cy="30%" r="70%">
            <stop offset="0" stopColor="rgba(255,255,255,0.95)" />
            <stop offset="0.35" stopColor="rgba(147,197,253,0.55)" />
            <stop offset="1" stopColor="rgba(37,99,235,0.25)" />
          </radialGradient>
        </defs>

        <circle
          cx="32"
          cy="32"
          r="18"
          fill={`url(#${orbitSphereId})`}
          stroke="rgba(37,99,235,0.25)"
          strokeWidth="1"
        />
        <path
          d={orbitPath}
          fill="none"
          stroke={`url(#${orbitStrokeId})`}
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.95"
        />

        {animated ? (
          <circle r="2.4" fill="white" style={satelliteStyle}>
            <animateMotion
              dur="5s"
              repeatCount="indefinite"
              rotate="auto"
              keyPoints="0;0;1"
              keyTimes="0;0.12;1"
              calcMode="linear"
              path={orbitPath}
            />
          </circle>
        ) : (
          <circle cx="56" cy="32" r="2.4" fill="white" style={satelliteStyle} />
        )}
      </svg>
    </div>
  );
}

export default function Page() {
  // ── Orbit+ transition (one-element, no clone) ────────────────────────────
  // The actual heading <div> IS the animated element. A dark overlay rises
  // behind it (z-15, below heading z-20). No duplicates ever exist.
  const router         = useRouter();
  const [isTransitioning, setIsTransitioning] = useState(false);
  const headingRef     = useRef<HTMLDivElement>(null); // 用于精确计算居中偏移
  const orbitTextRef   = useRef<HTMLSpanElement>(null); // 「Orbit」中心：位移目标 + 缩放锚点
  const headingAnim    = useAnimation(); // moves/scales the real heading
  /** 转场时把 transform-origin 钉在「Orbit」上，避免整块从几何中心放大造成「先胀后飘」的错觉 */
  const [orbitPlusHeadingOrigin, setOrbitPlusHeadingOrigin] = useState<string | undefined>(undefined);
  const helloAnim      = useAnimation(); // collapses "Hello, I'm"
  const subtitleAnim   = useAnimation(); // collapses greeting + tagline together
  const plusAnim       = useAnimation(); // fades in "+"
  const overlayAnim    = useAnimation(); // dark background
  // 光束扫过 "+" 的 background-position（CSS transition 驱动，只在 bg-clip-text 内可见）
  const [plusBgPos, setPlusBgPos] = useState("100% 0%"); // 初始：光束在左下角外

  const handleOrbitPlusTransition = async () => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    setIsAuraHovered(false);

    // ── Phase 1 (0.18s): 快速收起 Hello/副标题，暗场升起 ──────────────────────
    // 此阶段让 CSS left-50% + translate(-50%) 的自动居中稳定下来，
    // 不同时启动 headingAnim，避免「Framer x 偏移 + CSS 自动补偿」叠加过头。
    overlayAnim.start({ opacity: 1, transition: { duration: 0.6, ease: "easeIn" } });
    await Promise.all([
      helloAnim.start({
        opacity: 0, maxWidth: "0px", marginRight: "0px",
        transition: { duration: 0.18, ease: "easeIn" },
      }),
      subtitleAnim.start({
        opacity: 0,
        transition: { duration: 0.18, ease: "easeIn" },
      }),
    ]);

    // 等两帧让浏览器重新 layout，getBoundingClientRect 才是稳定后的位置
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    // ── Phase 2 (0.75s): 量好新位置，Orbit 同时放大 + 斜向移到视口中心 ─────────
    const oRect = orbitTextRef.current?.getBoundingClientRect();
    const hRect = headingRef.current?.getBoundingClientRect();
    const cx = oRect ? oRect.left + oRect.width  / 2 : window.innerWidth  / 2;
    const cy = oRect ? oRect.top  + oRect.height / 2 : window.innerHeight * 0.4;
    const toCenterX = window.innerWidth  / 2 - cx;
    const toCenterY = window.innerHeight / 2 - cy;

    if (hRect && oRect) {
      const ox = cx - hRect.left;
      const oy = cy - hRect.top;
      flushSync(() => setOrbitPlusHeadingOrigin(`${ox}px ${oy}px`));
    }

    await headingAnim.start({
      x: toCenterX,
      y: toCenterY,
      scale: 2.1,
      transition: { duration: 0.75, ease: [0.16, 1, 0.3, 1] },
    });

    // Phase 3: 光从左下往右上扫过 "+" 内部，"+" 在光芒中缓缓浮现
    // bg-clip-text 确保亮光只在 "+" 字形内可见，光束不出字
    // "100% 0%" = 光束在左下外 → "0% 100%" = 光束在右上外（CSS transition 驱动）
    setPlusBgPos("0% 100%");
    await plusAnim.start({
      opacity: [0, 0.12, 0.88, 1],
      transition: {
        duration: 1.05,
        ease: "easeOut",
        times: [0, 0.2, 0.75, 1],
      },
    });

    // Phase 4: 短暂停顿
    await new Promise<void>((r) => setTimeout(r, 160));

    // Phase 5: 整体淡出到黑（overlay 已满，heading 透明化）
    // 不再做"飞向标题位置"——用黑暗遮挡切换，轨迹连贯感由 orbit-plus 入场动画接续
    sessionStorage.setItem("orbitTransition", "1");
    // 在 router.push 之前将 body 背景设为黑色，防止路由切换时出现白屏闪烁
    document.body.style.backgroundColor = "#0d0e10";
    await headingAnim.start({
      opacity: 0,
      transition: { duration: 0.28, ease: "easeIn" },
    });

    router.push("/orbit-plus");
  };
  // ─────────────────────────────────────────────────────────────────────────

  const [documents, setDocuments] = useState<string[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [isDocsLoading, setIsDocsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelKey>("speed");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState<'none' | 'history' | 'edit'>('none');
  const [editContent, setEditContent] = useState('');
  const [tags, setTags] = useState<{ id: number; snippet: string; instruction: string; start: number; end: number }[]>([]);
  const [selectionText, setSelectionText] = useState('');
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const [activeTagId, setActiveTagId] = useState<number | null>(null);
  const [hoveredTagId, setHoveredTagId] = useState<number | null>(null);
  const [highlightRects, setHighlightRects] = useState<Array<{ top: number; left: number; width: number; height: number }>>([]);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [pendingOptimizedContent, setPendingOptimizedContent] = useState<string | null>(null);
  const [diffParts, setDiffParts] = useState<Array<{ value: string; added?: boolean; removed?: boolean }>>([]);
  const [diffChangeCount, setDiffChangeCount] = useState(0);
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  // ── Orbit Aura ─────────────────────────────────────────────────────────────
  const [isAuraOpen, setIsAuraOpen] = useState(false);
  const [isAuraHovered, setIsAuraHovered] = useState(false);
  const [auraMessages, setAuraMessages] = useState<Message[]>([]);
  const [auraInput, setAuraInput] = useState("");
  const [isAuraThinking, setIsAuraThinking] = useState(false);
  // ────────────────────────────────────────────────────────────────────────────

  const [greeting, setGreeting] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isCitationsPending, setIsCitationsPending] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<SelectedEvidence | null>(null);

  /** Aura 入口的渐变框 / 气泡：仅首页空会话时显示；Orbit+ 转场中必须关掉，否则会盖住转场字 */
  const showAuraChrome = messages.length === 0 && !isTransitioning;

  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const themeEffectSkipRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editMirrorRef = useRef<HTMLDivElement | null>(null);
  const highlightRafRef = useRef<number | null>(null);
  const auraEndRef = useRef<HTMLDivElement | null>(null);
  const auraInputRef = useRef<HTMLTextAreaElement | null>(null);
  const auraAbortRef = useRef<AbortController | null>(null);
  const auraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const auraRafRef = useRef<number | null>(null);
  type AuraBubble = { x: number; y: number; r: number; vy: number; phase: number; opacity: number; fade: number; colorIndex: number };
  const auraBubblesRef = useRef<AuraBubble[]>([]);
  const selectedDocsSummary = selectedDocs.length > 0
    ? selectedDocs.map((name) => name.replace(/\.pdf$/i, "")).join("、")
    : "全库";
  const selectedDocsPreview = selectedDocs.length > 0
    ? (() => {
        const names = selectedDocs.map((name) => name.replace(/\.pdf$/i, ""));
        if (names.length === 1) return names[0];
        const preview = names.slice(0, 2).join("、");
        return names.length > 2 ? `${preview} 等 ${names.length} 篇` : preview;
      })()
    : "全库检索";

  const refreshDocuments = async () => {
    setIsDocsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/documents`);
      if (!res.ok) throw new Error(`GET /documents 失败（HTTP ${res.status}）`);
      const list = (await res.json()) as string[];
      const normalized = Array.from(new Set(list)).sort();
      setDocuments(normalized);
      setSelectedDocs((prev) => prev.filter((x) => normalized.includes(x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载文献列表失败");
    } finally {
      setIsDocsLoading(false);
    }
  };

  const toggleDoc = (name: string) => {
    setSelectedDocs((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  };

  const deleteDocument = async (name: string) => {
    if (!confirm(`确定删除 "${name}" ?`)) return;
    try {
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `DELETE /documents/${name} 失败（HTTP ${res.status}）`);
      }
      setDocuments((prev) => prev.filter((x) => x !== name));
      setSelectedDocs((prev) => prev.filter((x) => x !== name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const deleteSelected = async () => {
    if (!selectedDocs.length) return;
    if (!confirm(`确定删除已选 ${selectedDocs.length} 个文献？`)) return;
    try {
      await Promise.all(
        selectedDocs.map((n) => fetch(`${API_BASE}/documents/${encodeURIComponent(n)}`, { method: "DELETE" }))
      );
      setDocuments((prev) => prev.filter((x) => !selectedDocs.includes(x)));
      setSelectedDocs([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "批量删除失败");
      void refreshDocuments();
    }
  };

  useEffect(() => {
    void refreshDocuments();
  }, []);

  useEffect(() => {
    const phrases = [
      "需要我为你做些什么？",
      "今天怎么样？",
      "让我们一起同行",
      "在浩瀚文献中，寻找你的灵感火花",
      "随时待命，乐于助人",
      "探索未知，从这里开始",
      "向着星辰与深渊！",
      "神经链已连接，欢迎接入赛博空间",
      "引擎已点火，正在计算跃迁坐标",
      "同步率 100%，你的专属 AI 导航员已上线",
      "在比特与字节的洪流中，寻找你的唯一解",
      "欢迎登录，正在为你加载未知领域的地图",
      "终端就绪! 输入你的意志，改变世界线",
      "愿原力与你的每一次探索同在",
      "突破次元壁，跨越数据之海为你而来",
      "在这里，每一个荒诞的念头都值得被认真对待",
      "空白的画卷，正期待你的第一笔",
      "灵感枯竭了？让我为你降一场脑力风暴",
      "从一个词汇开始，构建你的整个宇宙",
      "为你理清乱麻，让思绪自然流淌",
      "为你的天马行空，装上落地的引擎",
      "打碎思维定势，我们一起来拼凑点不一样的",
      "用算法编织梦境，用文字重塑现实",
      "逆锋起笔，最能得势",
      "生而无畏，战至终章！",
    ];
    const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
    setGreeting(randomPhrase);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const prefersDark = window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false;
    const initial = saved ? saved === "dark" : prefersDark;

    setIsDarkMode(initial);
    document.documentElement.classList.toggle("dark", initial);
    localStorage.setItem("theme", initial ? "dark" : "light");
  }, []);

  useEffect(() => {
    if (themeEffectSkipRef.current) {
      themeEffectSkipRef.current = false;
      return;
    }

    document.documentElement.classList.toggle("dark", isDarkMode);
    localStorage.setItem("theme", isDarkMode ? "dark" : "light");
  }, [isDarkMode]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (modelMenuButtonRef.current?.contains(target)) return;
      if (modelMenuPanelRef.current?.contains(target)) return;
      setIsMenuOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [isMenuOpen]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isThinking]);

  useEffect(() => {
    auraEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [auraMessages, isAuraThinking]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    if (!selectedEvidence || selectedEvidence.status === "ready") return;

    const message = messages.find((item) => item.id === selectedEvidence.messageId);
    if (!message?.citationCards?.length) return;

    const card = message.citationCards.find((item) => item.num === selectedEvidence.refNum);
    if (!card) return;

    setSelectedEvidence({
      messageId: selectedEvidence.messageId,
      refNum: selectedEvidence.refNum,
      status: "ready",
      card,
    });
  }, [messages, selectedEvidence]);

  // ── Canvas 水波气泡动画 ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = auraCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // 只在有实际尺寸时初始化
    if (canvas.offsetWidth === 0) return;

    if (isAuraHovered) {
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
    }

    if (!isAuraHovered) {
      // 悬停结束：让现有气泡淡出
      auraBubblesRef.current.forEach((b) => { b.fade = -0.022; });
      if (auraBubblesRef.current.length === 0) return;
    }

    let animating = true;
    let frame = 0;

    const spawnBubble = () => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const r = Math.random() * 10 + 5;
      auraBubblesRef.current.push({
        x: r + Math.random() * (w - r * 2),
        y: h + r,
        r,
        vy: Math.random() * 0.40 + 0.18,
        phase: Math.random() * Math.PI * 2,
        opacity: 0,
        fade: Math.random() * 0.009 + 0.005,
        colorIndex: Math.floor(Math.random() * 4),
      });
    };

    const tick = () => {
      if (!animating) return;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      frame++;
      if (isAuraHovered && frame % 8 === 0 && auraBubblesRef.current.length < 22) {
        spawnBubble();
      }

      // 4 种色系：白蓝 / 白紫 / 白粉 / 天蓝→紫
      const palettes: [number[], number[]][] = [
        [[255, 255, 255], [96,  165, 250]],   // white → blue-400
        [[255, 255, 255], [167, 139, 250]],   // white → violet-400
        [[255, 255, 255], [244, 114, 182]],   // white → pink-400
        [[186, 230, 253], [196, 181, 253]],   // sky-200 → violet-300
      ];

      const t = Date.now() * 0.001;
      auraBubblesRef.current = auraBubblesRef.current.filter((b) => {
        b.y -= b.vy;
        b.x += Math.sin(b.phase + t * 0.8) * 0.36;
        b.opacity += b.fade;
        if (b.opacity > 0.58) { b.opacity = 0.58; b.fade = 0; }
        if (b.y + b.r < 0 || b.opacity <= 0) return false;

        const [inner, outer] = palettes[b.colorIndex % 4];
        const op = b.opacity;

        // 径向渐变填充（玻璃质感：白中心 → 彩色边缘）
        const grad = ctx.createRadialGradient(
          b.x - b.r * 0.3, b.y - b.r * 0.32, b.r * 0.06,
          b.x, b.y, b.r
        );
        grad.addColorStop(0,   `rgba(${inner.join(",")}, ${op * 0.88})`);
        grad.addColorStop(0.55,`rgba(${inner.join(",")}, ${op * 0.35})`);
        grad.addColorStop(1,   `rgba(${outer.join(",")}, ${op * 0.28})`);

        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // 彩色描边（rim）
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${outer.join(",")}, ${op * 0.55})`;
        ctx.lineWidth = 0.9;
        ctx.stroke();

        // 顶部高光小点（玻璃反光）
        const glintGrad = ctx.createRadialGradient(
          b.x - b.r * 0.32, b.y - b.r * 0.34, 0,
          b.x - b.r * 0.32, b.y - b.r * 0.34, b.r * 0.3
        );
        glintGrad.addColorStop(0, `rgba(255,255,255,${op * 0.80})`);
        glintGrad.addColorStop(1, `rgba(255,255,255,0)`);
        ctx.beginPath();
        ctx.arc(b.x - b.r * 0.32, b.y - b.r * 0.34, b.r * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = glintGrad;
        ctx.fill();

        return true;
      });

      ctx.restore();
      if (animating && (isAuraHovered || auraBubblesRef.current.length > 0)) {
        auraRafRef.current = requestAnimationFrame(tick);
      }
    };

    auraRafRef.current = requestAnimationFrame(tick);

    return () => {
      animating = false;
      if (auraRafRef.current !== null) {
        cancelAnimationFrame(auraRafRef.current);
        auraRafRef.current = null;
      }
    };
  }, [isAuraHovered]);
  // ────────────────────────────────────────────────────────────────────────────

  const onNewChat = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsThinking(false);
    setIsCitationsPending(false);
    setError(null);
    setMessages([]);
    setSelectedEvidence(null);
    setInput("");
  };

  const onPickFile = () => {
    console.log('--- 按钮被点击了 ---');
    console.log("[upload] fileRef.current =", fileRef.current);

    const el = fileRef.current;
    if (!el) {
      console.log("[upload] file input not mounted");
      return;
    }

    const maybeShowPicker = (el as unknown as { showPicker?: () => void }).showPicker;
    if (typeof maybeShowPicker === "function") {
      console.log("[upload] calling input.showPicker()");
      maybeShowPicker.call(el);
      return;
    }

    console.log("[upload] calling input.click()");
    el.click();
  };

  const onFilesSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    console.log("[upload] onFilesSelected fired");
    const file = e.target.files?.[0];
    console.log("[upload] selected file =", file?.name);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      e.target.value = "";
      return;
    }

    setIsUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        body: fd,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `POST /upload 失败（HTTP ${res.status}）`);
      }

      await refreshDocuments();

      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          content: `已上传：${file.name}。你可以勾选左侧文献，再提问。`,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setIsUploading(false);
      e.target.value = "";
    }
  };

  const generateSemanticTitle = async (content: string, messageIndex: number) => {
    const clipped = (content || "").slice(0, 1500);
    const prompt =
      "请将下面这段文字的核心内容概括为一个5到10个字的精简标题。严格要求：只输出标题纯文本，不要任何标点符号、书名号、换行或多余解释。\n\n正文：\n" +
      clipped;

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) return;

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";
      let title = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = extractSseEvents(buffer);
        buffer = parsed.rest;

        for (const ev of parsed.events) {
          if (ev.event === "meta") continue;
          if (ev.event === "end" && ev.data === "[DONE]") {
            await reader.cancel();
            break;
          }
          if (ev.event === "error") return;

          if (!ev.data) continue;
          title += ev.data.replaceAll("\\n", "\n");
        }
      }

      let cleanTitle = title.replace(/[\r\n]+/g, " ").trim();
      cleanTitle = cleanTitle
        .replace(/[，。！？,.!?:;；："“”'‘’（）()《》<>【】\[\]—–\-]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!cleanTitle) cleanTitle = "AI 洞察片段";

      setMessages((prev) => {
        if (messageIndex < 0 || messageIndex >= prev.length) return prev;
        const target = prev[messageIndex];
        if (!target) return prev;
        const next = [...prev];
        next[messageIndex] = { ...target, title: cleanTitle };
        return next;
      });
    } catch {
      return;
    }
  };

  const send = async () => {
    console.log("[chat] send clicked", {
      inputLen: input.length,
      isThinking,
      isCitationsPending,
      documents: documents.length,
      selectedDocs,
    });

    const text = input.trim();
    if (!text || isThinking || isCitationsPending) return;

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    setError(null);

    const assistantId = makeId();
    const assistantIndex = messages.length + 1;
    setMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", content: text },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setInput("");

    setIsThinking(true);
    setIsCitationsPending(false);

    try {
      const outboundMessages = [
        ...messages
          .filter((m) => m.content.trim().length > 0)
          .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
        { role: "user" as const, content: text },
      ];

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: outboundMessages,
          selected_files: selectedDocs,
          model: MODEL_OPTIONS[selectedModel].id,
        }),
        signal: abortControllerRef.current?.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(errText || `POST /chat 失败（HTTP ${res.status}）`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("响应体为空，无法进行流式读取");

      const decoder = new TextDecoder();
      let buffer = "";
      let rawContent = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = extractSseEvents(buffer);
        buffer = parsed.rest;

        for (const ev of parsed.events) {
          if (ev.event === "meta") {
            // chat meta 目前不再驱动首页 UI，保留事件兼容但无需落库
            continue;
          }
          if (ev.event === "end" && ev.data === "[DONE]") {
            await reader.cancel();
            break;
          }
          if (ev.event === "error") throw new Error(ev.data || "流式返回错误");

          if (!ev.data) continue;
          const token = ev.data.replaceAll("\\n", "\n");
          rawContent += token;
          const parsedContent = splitAnswerAndCitationPayload(rawContent);
          const bodyLooksDone = parsedContent.citationBlockStarted || /\[\d+\]\s*$/.test(parsedContent.content.trim());

          if (bodyLooksDone) {
            setIsThinking(false);
          }
          setIsCitationsPending(parsedContent.citationBlockStarted && !parsedContent.citationBlockComplete);

          setMessages((prev) =>
            prev.map((m) => (
              m.id === assistantId
                ? {
                    ...m,
                    content: parsedContent.content,
                    citationCards: parsedContent.citationCards,
                  }
                : m
            ))
          );
        }
      }

      const finalParsed = splitAnswerAndCitationPayload(rawContent);
      setIsThinking(false);
      setIsCitationsPending(false);
      setMessages((prev) =>
        prev.map((m) => (
          m.id === assistantId
            ? {
                ...m,
                content: finalParsed.content,
                citationCards: finalParsed.citationCards,
              }
            : m
        ))
      );

      if (finalParsed.content.trim()) {
        void generateSemanticTitle(finalParsed.content, assistantIndex);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;

      const msg = e instanceof Error ? e.message : "请求失败";
      setError(msg);
      setIsCitationsPending(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: m.content || `请求失败：${msg}` } : m))
      );
    } finally {
      abortControllerRef.current = null;
      setIsThinking(false);
      setIsCitationsPending(false);
    }
  };

  const openEvidenceCard = (message: Message, refNum: number) => {
    const card = (message.citationCards || []).find((item) => item.num === refNum);
    setSelectedEvidence(
      card
        ? {
            messageId: message.id,
            refNum,
            status: "ready",
            card,
          }
        : {
            messageId: message.id,
            refNum,
            status: "loading",
          }
    );
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsThinking(false);
    setIsCitationsPending(false);
  };

  // ── Orbit Aura handlers ───────────────────────────────────────────────────
  const handleEnterAura = () => {
    setIsAuraHovered(false);
    setIsAuraOpen(true);
    setTimeout(() => auraInputRef.current?.focus(), 700);
  };

  const handleExitAura = () => {
    auraAbortRef.current?.abort();
    auraAbortRef.current = null;
    setIsAuraOpen(false);
  };

  const sendAuraMessage = async () => {
    const text = auraInput.trim();
    if (!text || isAuraThinking) return;

    auraAbortRef.current?.abort();
    auraAbortRef.current = new AbortController();

    const assistantId = makeId();
    setAuraMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", content: text },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setAuraInput("");
    setIsAuraThinking(true);

    try {
      const outbound = [
        ...auraMessages
          .filter((m) => m.content.trim())
          .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
        { role: "user" as const, content: text },
      ];

      const res = await fetch(`${API_BASE}/aura-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: outbound }),
        signal: auraAbortRef.current.signal,
      });

      if (!res.ok) throw new Error("请求失败");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无响应流");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = extractSseEvents(buffer);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.event === "meta") continue;
          if (ev.event === "end" && ev.data === "[DONE]") { await reader.cancel(); break; }
          if (ev.event === "error") throw new Error(ev.data || "错误");
          if (!ev.data) continue;
          const token = ev.data.replaceAll("\\n", "\n");
          setAuraMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + token } : m))
          );
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      // 把错误信息写进最后一条 assistant 消息，让用户看见
      const errMsg = e instanceof Error ? e.message : String(e);
      setAuraMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && !last.content) {
          return prev.map((m) =>
            m.id === last.id ? { ...m, content: `（连接出错：${errMsg}）` } : m
          );
        }
        return prev;
      });
    } finally {
      auraAbortRef.current = null;
      setIsAuraThinking(false);
    }
  };
  // ────────────────────────────────────────────────────────────────────────────

  const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const countDiffBlocks = (parts: Array<{ added?: boolean; removed?: boolean }>) => {
    let count = 0;
    let inBlock = false;
    for (const p of parts) {
      if (p.added || p.removed) {
        if (!inBlock) count += 1;
        inBlock = true;
      } else {
        inBlock = false;
      }
    }
    return count;
  };

  const computeHighlightRects = (range: { start: number; end: number } | null) => {
    const ta = editTextareaRef.current;
    const mirror = editMirrorRef.current;
    if (!ta || !mirror || !range) {
      setHighlightRects([]);
      return;
    }

    const start = Math.max(0, Math.min(range.start, range.end));
    const end = Math.max(0, Math.max(range.start, range.end));
    const value = ta.value || "";

    if (start === end || start >= value.length || end > value.length) {
      setHighlightRects([]);
      return;
    }

    const before = value.slice(0, start);
    const mid = value.slice(start, end);
    const after = value.slice(end);

    mirror.innerHTML = `${escapeHtml(before)}<span data-sel>${escapeHtml(mid)}</span>${escapeHtml(after)}`;
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;

    const sel = mirror.querySelector("[data-sel]") as HTMLElement | null;
    if (!sel) {
      setHighlightRects([]);
      return;
    }

    const base = mirror.getBoundingClientRect();
    const rects = Array.from(sel.getClientRects())
      .map((r) => ({ top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height }))
      .filter((r) => r.width > 0 && r.height > 0);

    setHighlightRects(rects);
  };

  useEffect(() => {
    const activeId = hoveredTagId ?? activeTagId;
    const tag = activeId ? tags.find((t) => t.id === activeId) : undefined;
    const activeRange = selectionRange ?? (tag ? { start: tag.start, end: tag.end } : null);
    computeHighlightRects(activeRange);
  }, [editContent, selectionRange, hoveredTagId, activeTagId, tags]);

  useEffect(() => {
    if (activeDrawer === 'edit' && pendingOptimizedContent && diffParts.length > 0) {
      setIsDiffOpen(true);
    }
  }, [activeDrawer, pendingOptimizedContent, diffParts.length]);

  const onCloseDiff = () => setIsDiffOpen(false);

  const onApplyDiff = () => {
    if (!pendingOptimizedContent) return;
    setEditContent(pendingOptimizedContent);
    setPendingOptimizedContent(null);
    setDiffParts([]);
    setDiffChangeCount(0);
    setIsDiffOpen(false);
    setTags([]);
    setActiveTagId(null);
    setHoveredTagId(null);
    setSelectionRange(null);
    setSelectionText('');
    setHighlightRects([]);
  };

  const handleOptimize = async () => {
    if (isOptimizing) return;
    const base = editContent.trim();
    if (!base || tags.length === 0) return;
    setIsOptimizing(true);
    try {
      const prompt =
        `你是一个世界顶级的学术文字编辑。\n【原始文本】：\n${base}\n\n用户对其中的特定片段提出了修改要求：\n${tags.map((t, i) => `片段${i + 1}:"${t.snippet}" -> 修改要求：${t.instruction}`).join('\n')}\n\n【你的任务】：\n严格按照上述要求，仅修改对应的片段。保留其余所有未标记部分的原文一字不差！\n直接输出修改后的完整长文本，不要输出任何多余的解释语、Markdown 代码块标记、参考文献列表、JSON、<<<ORBIT_CITATIONS_JSON>>>、<<<END_ORBIT_CITATIONS_JSON>>> 或开场白。`;

      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: prompt }] }),
      });

      if (!res.ok) throw new Error('优化请求失败');

      const reader = res.body?.getReader();
      let output = '';
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = extractSseEvents(buffer);
          buffer = parsed.rest;
          for (const ev of parsed.events) {
            if (ev.event === 'meta') continue;
            if (ev.event === 'end' && ev.data === '[DONE]') { await reader.cancel(); break; }
            if (ev.event === 'error') continue;
            if (!ev.data) continue;
            output += ev.data.replaceAll('\\n', '\n');
          }
        }
      } else {
        output = await res.text();
      }

      const cleanedOutput = stripCitationPayload(output);
      const nextText = cleanedOutput.trim();
      if (nextText) {
        const parts = diffWords(editContent, nextText) as Array<{ value: string; added?: boolean; removed?: boolean }>;
        setPendingOptimizedContent(nextText);
        setDiffParts(parts);
        setDiffChangeCount(countDiffBlocks(parts));
        setIsDiffOpen(true);
      }
    } catch (e) {
      // no-op
    } finally {
      setIsOptimizing(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-white dark:bg-[#131314] text-gray-900 dark:text-gray-100 transition-colors duration-500 ease-in-out">
      <aside
        className={`transition-all duration-300 ease-in-out flex-shrink-0 flex flex-col h-full border-r border-black/[0.06] dark:border-white/[0.06] bg-[#f5f5f7] dark:bg-[#1c1c1e] ${
          isSidebarOpen ? "w-64" : "w-0 overflow-hidden border-none"
        }`}
      >
        {/* 新对话 */}
        <div className="px-3 pt-4 pb-2">
          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-900 dark:bg-white/[0.1] px-4 py-2.5 text-sm font-semibold text-white dark:text-white/90 transition hover:bg-gray-700 dark:hover:bg-white/[0.15] active:scale-[0.98]"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            新对话
          </button>
        </div>

        {/* 文献区标题 */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-[11px] font-semibold tracking-widest text-gray-400 dark:text-white/30 uppercase">文献</span>
          <div className="flex items-center gap-1.5">
            {isDocsLoading && <LoaderCircle className="h-3 w-3 animate-spin text-gray-400" />}
            {documents.length > 0 && (
              <span className="rounded-full bg-gray-200/80 dark:bg-white/[0.08] px-2 py-0.5 text-[10px] font-semibold text-gray-500 dark:text-white/40 tabular-nums">
                {documents.length}
              </span>
            )}
          </div>
        </div>

        {/* 文献列表 */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {documents.length === 0 ? (
            <div className="mx-1 mt-1 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-gray-300/70 dark:border-white/[0.08] px-4 py-6 text-center">
              <FileText className="h-7 w-7 text-gray-300 dark:text-white/20" />
              <p className="text-xs text-gray-400 dark:text-white/30 leading-relaxed">上传 PDF 开始<br />文献分析</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {documents.map((name) => {
                const checked = selectedDocs.includes(name);
                return (
                  <label
                    key={name}
                    className={`group flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 transition-all duration-150 ${
                      checked
                        ? "bg-white dark:bg-white/[0.07] shadow-sm"
                        : "hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                    }`}
                  >
                    {/* 选中指示器 */}
                    <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border transition-all ${
                      checked
                        ? "border-transparent bg-gray-900 dark:bg-white"
                        : "border-gray-300 dark:border-white/20"
                    }`}>
                      {checked && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <path d="M1.5 4L3.2 5.7L6.5 2.5" stroke={`currentColor`} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                            className="text-white dark:text-gray-900" />
                        </svg>
                      )}
                    </span>
                    <input type="checkbox" checked={checked} onChange={() => toggleDoc(name)} className="sr-only" />

                    {/* 图标 */}
                    <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
                      checked ? "bg-red-50 dark:bg-red-500/10" : "bg-gray-200/60 dark:bg-white/[0.06]"
                    }`}>
                      <FileText className={`h-3.5 w-3.5 ${checked ? "text-red-400" : "text-gray-400 dark:text-white/30"}`} />
                    </span>

                    {/* 文件名 */}
                    <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-tight transition-colors ${
                      checked ? "font-medium text-gray-900 dark:text-white/90" : "text-gray-600 dark:text-white/50"
                    }`}>
                      {name.replace(/\.pdf$/i, "")}
                    </span>

                    {/* 删除 */}
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void deleteDocument(name); }}
                      className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-md p-0.5 text-gray-300 dark:text-white/20 hover:text-red-400 dark:hover:text-red-400"
                      aria-label="删除文献"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="px-3 pb-4 pt-2 space-y-2">
          {selectedDocs.length > 0 && (
            <button
              type="button"
              onClick={() => void deleteSelected()}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-red-500/10 dark:bg-red-500/[0.12] px-3 py-2 text-xs font-semibold text-red-500 dark:text-red-400 transition hover:bg-red-500/[0.15] active:scale-[0.98]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除已选 ({selectedDocs.length})
            </button>
          )}
          <input id="pdf-upload" ref={fileRef} type="file" accept="application/pdf" className="sr-only" onChange={onFilesSelected} />
          <label
            htmlFor="pdf-upload"
            onClick={() => { console.log("[upload] fileRef.current =", fileRef.current); }}
            className="flex w-full cursor-pointer select-none items-center justify-center gap-1.5 rounded-xl border border-gray-300/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.04] px-4 py-2.5 text-xs font-semibold text-gray-600 dark:text-white/50 transition hover:bg-white dark:hover:bg-white/[0.07] active:scale-[0.98]"
          >
            {isUploading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {isUploading ? "上传中…" : "上传 PDF"}
          </label>
        </div>
      </aside>

      <div className="flex-1 flex flex-col h-full relative">
        <header className="flex items-center justify-between p-4 bg-transparent absolute top-0 left-0 right-0 z-10">
          <button
            type="button"
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500"
            aria-label="Toggle sidebar"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          <motion.button
            type="button"
            onClick={() => setIsDarkMode((v) => !v)}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.98 }}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500"
            aria-label={isDarkMode ? "Switch to light" : "Switch to dark"}
          >
            {isDarkMode ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4"></circle>
                <line x1="12" y1="2" x2="12" y2="6"></line>
                <line x1="12" y1="18" x2="12" y2="22"></line>
                <line x1="2" y1="12" x2="6" y2="12"></line>
                <line x1="18" y1="12" x2="22" y2="12"></line>
                <line x1="4.2" y1="4.2" x2="7" y2="7"></line>
                <line x1="17" y1="17" x2="19.8" y2="19.8"></line>
                <line x1="4.2" y1="19.8" x2="7" y2="17"></line>
                <line x1="17" y1="7" x2="19.8" y2="4.2"></line>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 0 1 11.2 3a7 7 0 1 0 9.8 9.8Z"></path>
              </svg>
            )}
          </motion.button>
        </header>

        <div className="fixed top-20 right-6 z-40 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setActiveDrawer('history')}
            className="w-10 h-10 rounded-full flex items-center justify-center bg-white/80 dark:bg-gray-800/80 backdrop-blur-md shadow-lg border border-gray-200/50 dark:border-gray-700/50 hover:scale-110 transition-transform cursor-pointer text-gray-600 dark:text-gray-300"
          >
            📂
          </button>
          <button
            type="button"
            onClick={() => setActiveDrawer('edit')}
            className="w-10 h-10 rounded-full flex items-center justify-center bg-white/80 dark:bg-gray-800/80 backdrop-blur-md shadow-lg border border-gray-200/50 dark:border-gray-700/50 hover:scale-110 transition-transform cursor-pointer text-gray-600 dark:text-gray-300"
          >
            ✏️
          </button>
        </div>

        <AnimatePresence>
          {activeDrawer === 'history' ? (
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 h-screen w-[400px] z-50 bg-white/85 dark:bg-[#131314]/85 backdrop-blur-2xl border-l border-gray-200/50 dark:border-gray-800/50 shadow-2xl flex flex-col"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200/50 dark:border-gray-800/50">
                <div className="text-sm font-semibold">📂 历史生成正文</div>
                <button
                  type="button"
                  onClick={() => setActiveDrawer('none')}
                  className="w-7 h-7 rounded-lg flex items-center justify-center bg-white/60 dark:bg-gray-800/60 backdrop-blur-md text-gray-600 dark:text-gray-300 border border-gray-200/50 dark:border-gray-700/50"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {messages.filter((m) => m.role === 'agent' || m.role === 'assistant').length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-gray-500">暂无历史生成内容，开始对话吧</div>
                ) : (
                  messages
                    .filter((m) => m.role === 'agent' || m.role === 'assistant')
                    .map((m) => (
                      <div
                        key={m.id}
                        className="group m-4 p-4 rounded-xl bg-gray-50/80 dark:bg-gray-800/40 border border-gray-100 dark:border-gray-700/50 hover:shadow-md transition-shadow relative flex flex-col gap-2 max-h-[300px]"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            const raw = m.content || '';
                            const cleanContent = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                            setEditContent((prev) => (prev.trim() ? prev + '\n\n' + cleanContent : cleanContent));
                            setActiveDrawer('edit');
                            setTimeout(() => editTextareaRef.current?.focus(), 0);
                          }}
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-xs px-2 py-1 rounded-md bg-white/70 dark:bg-gray-800/70 backdrop-blur-md border border-gray-200/40 dark:border-gray-700/40"
                        >
                          ✏️ 提取至编辑
                        </button>
                        <h4 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2 truncate">
                          {m.title ? (
                            m.title
                          ) : (
                            <span className="text-sm text-gray-400 font-normal inline-flex items-center gap-2">
                              <span className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                              正在提炼核心...
                            </span>
                          )}
                        </h4>
                        <div className="prose prose-sm max-w-none dark:prose-invert text-xs text-gray-500 dark:text-gray-400 line-clamp-3 overflow-hidden relative">
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{m.content}</ReactMarkdown>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </motion.div>
          ) : null}

          {activeDrawer === 'edit' ? (
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 h-screen w-[400px] z-50 bg-white/85 dark:bg-[#131314]/85 backdrop-blur-2xl border-l border-gray-200/50 dark:border-gray-800/50 shadow-2xl flex flex-col"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200/50 dark:border-gray-800/50">
                <div className="text-sm font-semibold">✏️ 文本精修工作台</div>
                {editContent.trim() ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditContent('');
                        setTags([]);
                        setSelectionRange(null);
                        setSelectionText('');
                        setHighlightRects([]);
                        setPendingOptimizedContent(null);
                        setDiffParts([]);
                        setDiffChangeCount(0);
                        setIsDiffOpen(false);
                        setActiveTagId(null);
                        setHoveredTagId(null);
                      }}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-500 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
                      aria-label="清空"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(editContent);
                          setIsCopied(true);
                          setTimeout(() => setIsCopied(false), 1200);
                        } catch {}
                      }}
                      className="p-1.5 rounded-md text-gray-400 hover:text-blue-500 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
                      aria-label="复制"
                    >
                      {isCopied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                ) : <div />}
                <button
                  type="button"
                  onClick={() => setActiveDrawer('none')}
                  className="w-7 h-7 rounded-lg flex items-center justify-center bg-white/60 dark:bg-gray-800/60 backdrop-blur-md text-gray-600 dark:text-gray-300 border border-gray-200/50 dark:border-gray-700/50"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <div className="relative">
                  <textarea
                    ref={editTextareaRef}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onMouseUp={() => {
                      const el = editTextareaRef.current;
                      if (!el) return;
                      const start = el.selectionStart ?? 0;
                      const end = el.selectionEnd ?? 0;
                      if (start === end) {
                        setSelectionText('');
                        setSelectionRange(null);
                        return;
                      }
                      setSelectionRange({ start, end });
                      setSelectionText(el.value.slice(start, end));
                    }}
                    onScroll={() => {
                      if (highlightRafRef.current) cancelAnimationFrame(highlightRafRef.current);
                      highlightRafRef.current = requestAnimationFrame(() => {
                        const activeId = hoveredTagId ?? activeTagId;
                        const tag = activeId ? tags.find((t) => t.id === activeId) : undefined;
                        const activeRange = selectionRange ?? (tag ? { start: tag.start, end: tag.end } : null);
                        computeHighlightRects(activeRange);
                      });
                    }}
                    className="w-full h-[50vh] rounded-2xl bg-white/70 dark:bg-[#1e1f20]/70 backdrop-blur-xl shadow ring-1 ring-black/5 dark:ring-white/10 px-3 py-2 text-sm leading-6 text-gray-900 dark:text-gray-100 outline-none"
                    placeholder="在此粘贴或输入需要精修的文本"
                  />

                  <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
                    {highlightRects.map((r, idx) => (
                      <div
                        key={idx}
                        className="absolute rounded-md bg-yellow-300/35 dark:bg-yellow-200/15 mix-blend-multiply dark:mix-blend-normal"
                        style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
                      />
                    ))}
                  </div>

                  <div
                    ref={editMirrorRef}
                    aria-hidden="true"
                    className="absolute inset-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 text-transparent pointer-events-none"
                  />
                </div>

                {selectionText ? (
                  <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.18 }} className="mt-2 flex items-center justify-between rounded-xl bg-white/70 dark:bg-gray-800/60 backdrop-blur-md border border-gray-200/50 dark:border-gray-700/50 px-3 py-2 text-xs text-gray-700 dark:text-gray-300">
                    <span>已选中片段 ➔</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectionRange) return;
                        const id = Date.now();
                        const { start, end } = selectionRange;
                        const snippet = editContent.slice(start, end);
                        setTags((prev) => [...prev, { id, snippet, instruction: '', start, end }]);
                        setActiveTagId(id);
                        setHoveredTagId(null);
                        setSelectionText('');
                        setSelectionRange(null);
                        setHighlightRects([]);
                        const el = editTextareaRef.current;
                        if (el) el.setSelectionRange(end, end);
                      }}
                      className="px-2 py-1 rounded-md bg-blue-500/90 text-white"
                    >
                      点击添加标签
                    </button>
                  </motion.div>
                ) : null}

                <div className="mt-3 space-y-3">
                  {tags.map((t, i) => (
                    <div
                      key={t.id}
                      onMouseEnter={() => setHoveredTagId(t.id)}
                      onMouseLeave={() => setHoveredTagId(null)}
                      onClick={() => setActiveTagId((prev) => (prev === t.id ? null : t.id))}
                      className="rounded-xl bg-gray-50/80 dark:bg-gray-800/40 border border-gray-100 dark:border-gray-700/50 p-3 flex flex-col gap-2 cursor-default"
                    >
                      <div className="flex items-center justify-between text-xs font-semibold">
                        <span>标签 {i + 1}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTags((prev) => prev.filter((x) => x.id !== t.id));
                            setActiveTagId((v) => (v === t.id ? null : v));
                            setHoveredTagId((v) => (v === t.id ? null : v));
                          }}
                          className="w-6 h-6 rounded-md bg-white/60 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/50"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="text-xs italic text-gray-500 dark:text-gray-400">“{t.snippet.substring(0, 20)}{t.snippet.length > 20 ? '...' : ''}”</div>
                      <input
                        value={t.instruction}
                        onChange={(e) => setTags(tags.map((x) => (x.id === t.id ? { ...x, instruction: e.target.value } : x)))}
                        placeholder="请输入对此片段的修改要求（如：更学术、修正语病）"
                        className="rounded-lg bg-white/60 dark:bg-gray-900/40 px-3 py-2 text-xs outline-none ring-1 ring-black/5 dark:ring-white/10"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="sticky bottom-0 bg-white/85 dark:bg-[#131314]/85 backdrop-blur-xl border-t border-gray-200/50 dark:border-gray-800/50 p-3">
                {tags.length === 0 ? (
                  <div className="w-full py-3 rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 text-sm font-medium flex items-center justify-center cursor-default bg-gray-50/50 dark:bg-gray-800/20">
                    ✨ 请在上方划选文字，添加局部精修指令
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => (pendingOptimizedContent ? setIsDiffOpen(true) : void handleOptimize())}
                    disabled={isOptimizing}
                    className="relative w-full py-3 rounded-xl overflow-hidden group border border-gray-200/50 dark:border-white/10 bg-white/40 dark:bg-[#1e1e1f]/40 backdrop-blur-xl shadow-[0_4px_24px_-8px_rgba(147,51,234,0.18)] transition-all duration-300 hover:shadow-[0_10px_36px_-10px_rgba(147,51,234,0.28)] hover:-translate-y-[1px] disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:-translate-y-0"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-purple-500/12 to-pink-500/10 opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                    <div className="absolute -inset-8 bg-[radial-gradient(circle_at_50%_50%,rgba(147,51,234,0.22),transparent_55%)] opacity-70 group-hover:opacity-100 transition-opacity duration-500" />

                    <div className="relative flex items-center justify-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {isOptimizing ? (
                        <span className="inline-flex items-center justify-center gap-2">
                          <LoaderCircle className="w-4 h-4 animate-spin" />
                          润色中...
                        </span>
                      ) : pendingOptimizedContent ? (
                        `显示预览 (${diffChangeCount}处修改)`
                      ) : (
                        `✨ 智能精修 (${tags.length} 个标签)`
                      )}
                    </div>
                  </button>
                )}
              </div>

              {isDiffOpen && pendingOptimizedContent ? (
                <div className="absolute inset-x-0 top-[52px] bottom-0 z-20 bg-white/90 dark:bg-[#131314]/90 backdrop-blur-xl">
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200/50 dark:border-gray-800/50">
                    <div className="text-sm font-semibold">✏️ 智能精修预览（共 {diffChangeCount} 处修改）</div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={onCloseDiff}
                        className="h-8 px-3 rounded-lg bg-white/60 dark:bg-gray-800/60 backdrop-blur-md text-gray-700 dark:text-gray-200 border border-gray-200/50 dark:border-gray-700/50 text-xs"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={onApplyDiff}
                        className="h-8 px-3 rounded-lg bg-blue-500/90 text-white border border-blue-500/30 text-xs"
                      >
                        确认合并
                      </button>
                    </div>
                  </div>

                  <div className="h-full overflow-y-auto p-4 pb-24">
                    <div className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800 dark:text-gray-200">
                      {diffParts.map((p, i) => (
                        <span
                          key={i}
                          className={
                            p.added
                              ? "text-green-700 dark:text-green-300 underline bg-green-50/80 dark:bg-green-950/40"
                              : p.removed
                                ? "text-red-700 dark:text-red-300 line-through bg-red-50/80 dark:bg-red-950/40"
                                : ""
                          }
                        >
                          {p.value}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* 动态漂浮的 Orbit 引擎 */}
        <motion.div
          ref={headingRef}
          animate={headingAnim}
          onMouseEnter={() => {
            if (messages.length === 0 && !isTransitioning && !isAuraOpen) setIsAuraHovered(true);
          }}
          onMouseLeave={() => setIsAuraHovered(false)}
          onClick={() => {
            if (messages.length === 0 && !isTransitioning && !isAuraOpen) handleEnterAura();
          }}
          className={`absolute z-20 flex flex-col transition-[top,left] duration-1000 ease-in-out ${
            messages.length === 0
              ? "left-1/2 -translate-x-1/2 items-center cursor-pointer"
              : "top-[22px] left-[68px] translate-x-0 items-start"
          }`}
          style={{
            ...(messages.length === 0 ? { top: "max(72px, calc(50vh - 148px))" } : {}),
            ...(orbitPlusHeadingOrigin ? { transformOrigin: orbitPlusHeadingOrigin } : {}),
          }}
        >
          {/* ── 渐变旋转边框框（仅非 Orbit+ 转场时） ── */}
          <div
            className={`relative rounded-[32px] ${
              showAuraChrome ? "px-10 py-5" : ""
            }`}
            style={
              showAuraChrome
                ? {
                    boxShadow: isAuraHovered
                      ? "0 0 32px rgba(167,139,250,0.22), 0 0 8px rgba(96,165,250,0.12)"
                      : undefined,
                    transition: "box-shadow 0.5s ease",
                  }
                : undefined
            }
          >
            {/* 旋转 conic-gradient 彩虹边框环 */}
            {showAuraChrome && (
              <div
                className="absolute pointer-events-none"
                style={{
                  inset: "-1.5px",
                  borderRadius: "33.5px",
                  overflow: "hidden",
                  opacity: isAuraHovered ? 1 : 0.48,
                  transition: "opacity 0.6s ease",
                }}
              >
                {/* 旋转的 conic gradient 铺满整个区域 */}
                <div
                  style={{
                    position: "absolute",
                    inset: "-50%",
                    background:
                      "conic-gradient(from 0deg at 50% 50%, #93c5fd, #a78bfa, #f472b6, #c084fc, #60a5fa, #93c5fd)",
                    animation: "aura-border-rotate 8s linear infinite",
                  }}
                />
                {/* 中央遮罩：只留 1.5px 环形边框可见 */}
                <div
                  className="absolute bg-white dark:bg-[#131314]"
                  style={{ inset: "1.5px", borderRadius: "32px" }}
                />
              </div>
            )}

            {/* Canvas 气泡 — 独立 overflow-hidden，不影响文字溢出 */}
            {showAuraChrome && (
              <div className="absolute inset-0 rounded-[32px] overflow-hidden pointer-events-none">
                <canvas ref={auraCanvasRef} className="w-full h-full" />
              </div>
            )}

            {/* 标题行 */}
            <div className="relative z-10 flex items-center">
              <motion.span
                animate={helloAnim}
                className={`overflow-hidden whitespace-nowrap text-gray-800 dark:text-gray-200 ${
                  isTransitioning
                    ? ""
                    : "transition-all duration-1000 ease-in-out "
                }${
                  messages.length === 0
                    ? "opacity-100 max-w-[300px] text-4xl md:text-5xl font-medium mr-3"
                    : "opacity-0 max-w-0 text-xl font-medium mr-0"
                }`}
              >
                Hello, I'm
              </motion.span>

              {messages.length > 0 ? <OrbitLogo size={28} animated={false} /> : null}
              <span
                ref={orbitTextRef}
                className={`transition-all duration-1000 ease-in-out font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-500 to-purple-500 ${
                  messages.length === 0 ? "text-4xl md:text-5xl" : "text-xl"
                }`}
              >
                Orbit
              </span>
              {/* "+" 扫光 */}
              <motion.span
                animate={plusAnim}
                initial={{ opacity: 0 }}
                className="font-bold select-none text-3xl md:text-4xl leading-none self-start mt-1"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg," +
                    "#1e293b  0%," +
                    "#334155 28%," +
                    "#94a3b8 40%," +
                    "#e2e8f0 46%," +
                    "#ffffff 50%," +
                    "#e2e8f0 54%," +
                    "#94a3b8 60%," +
                    "#334155 72%," +
                    "#1e293b 100%)",
                  backgroundSize: "300% 300%",
                  backgroundPosition: plusBgPos,
                  transition: "background-position 1.0s cubic-bezier(0.4,0,0.2,1)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                +
              </motion.span>
            </div>

            {/* 副标题 — 框内，min-h 给 absolute greeting 留出显示空间 */}
            <motion.div
              animate={subtitleAnim}
              className={`relative z-10 w-full flex justify-center ${
                showAuraChrome ? "min-h-[40px]" : ""
              }`}
            >
              <p
                className={`absolute whitespace-nowrap text-gray-500 dark:text-gray-400 text-lg transition-all duration-700 ease-in-out ${
                  messages.length === 0
                    ? "opacity-100 mt-2 translate-y-0"
                    : "opacity-0 translate-y-4 pointer-events-none"
                }`}
              >
                {greeting}
              </p>
              <p
                className={`whitespace-nowrap text-xs text-gray-400 transition-all duration-700 delay-300 ease-in-out ${
                  messages.length === 0
                    ? "opacity-0 translate-y-2 pointer-events-none absolute"
                    : "opacity-100 translate-y-0 mt-[2px]"
                }`}
              >
                Beyond the text, into the boundless.
              </p>
            </motion.div>
          </div>
        </motion.div>

        <div className="flex-1 overflow-y-auto pt-20 pb-40 px-4">
          <div className="max-w-3xl mx-auto flex flex-col gap-6 h-full relative">

            {messages.length === 0 ? null : (
              <AnimatePresence initial={false}>
                {messages.map((m) => {
                  const isUser = m.role === "user";
                  return (
                    <motion.div
                      key={m.id}
                      initial={bubbleMotion.initial}
                      animate={bubbleMotion.animate}
                      exit={bubbleMotion.exit}
                      transition={bubbleMotion.transition}
                      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
                    >
                      <div className={`flex w-full items-start gap-3 ${isUser ? "justify-end" : ""}`}>
                        {!isUser ? (
                          <OrbitLogo
                            size={40}
                            animated={isThinking && messages[messages.length - 1]?.id === m.id}
                          />
                        ) : null}
                        <div
                          className={`max-w-[85%] rounded-2xl text-sm leading-6 ${
                            isUser
                              ? "px-4 py-2 bg-gray-100 text-gray-900 dark:bg-white/[0.09] dark:text-white/95"
                              : "px-0 py-1 bg-transparent text-gray-900 ring-0 shadow-none dark:text-gray-100"
                          }`}
                        >
                          {isUser ? (
                            m.content
                          ) : (
                            <div className="prose prose-sm max-w-none dark:prose-invert
                              prose-strong:font-semibold prose-strong:text-gray-900 dark:prose-strong:text-white
                              prose-em:italic prose-em:text-gray-800 dark:prose-em:text-gray-200
                              prose-code:text-[0.82em] prose-code:font-mono prose-code:bg-gray-100 dark:prose-code:bg-white/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none
                              prose-pre:bg-gray-50 dark:prose-pre:bg-white/[0.05] prose-pre:rounded-xl prose-pre:text-sm
                              prose-blockquote:border-l-blue-300 dark:prose-blockquote:border-l-blue-500/50 prose-blockquote:text-gray-600 dark:prose-blockquote:text-gray-400
                              prose-p:leading-7 prose-li:leading-7">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkBreaks]}
                                components={{
                                  a: ({ node, href, children, ...props }) => {
                                    const refMatch = href?.match(/^#ref-(\d+)$/);
                                    if (refMatch) {
                                      const num = refMatch[1];
                                      return (
                                        <button
                                          type="button"
                                          onClick={() => openEvidenceCard(m, Number(num))}
                                          className="inline-block relative -top-1.5 ml-0.5 px-1.5 h-[18px] leading-[18px] min-w-[22px] text-center text-[10px] font-semibold font-mono tabular-nums text-gray-600 dark:text-gray-300 bg-gray-100/60 dark:bg-gray-800/40 rounded-[6px] backdrop-blur-md shadow-[0_1px_2px_rgba(0,0,0,0.06)] border-x border-black/10 dark:border-white/10 border-y-0 hover:bg-gray-200/70 dark:hover:bg-gray-700/50 transition-colors duration-200 cursor-pointer no-underline"
                                          title={`查看证据 ${num}`}
                                        >
                                          {`[${num}]`}
                                        </button>
                                      );
                                    }
                                    const isHash = href?.startsWith('#');
                                    return (
                                      <a href={href} className="text-blue-500 hover:underline" target={isHash ? undefined : '_blank'} rel={isHash ? undefined : 'noreferrer'} {...props}>
                                        {children}
                                      </a>
                                    );
                                  },
                                  hr: ({ node, className, ...props }) => (
                                    <hr className={["my-6 border-gray-200 dark:border-gray-700", className].filter(Boolean).join(" ")} {...props} />
                                  ),
                                  h1: ({ node, className, ...props }) => (
                                    <h1 className={["mt-2 mb-2 font-semibold first:mt-0 last:mb-0", className].filter(Boolean).join(" ")} {...props} />
                                  ),
                                  h2: ({ node, className, ...props }) => (
                                    <h2 className={["mt-2 mb-2 font-semibold first:mt-0 last:mb-0", className].filter(Boolean).join(" ")} {...props} />
                                  ),
                                  h3: ({ node, children, className, ...props }) => {
                                    return (
                                      <h3 className={["text-lg font-bold mt-4 mb-2", className].filter(Boolean).join(" ")} {...props}>
                                        {children}
                                      </h3>
                                    );
                                  },
                                  p: ({ node, children, className, ...props }) => {
                                    return (
                                      <p
                                        className={["my-1.5 first:mt-0 last:mb-0", className].filter(Boolean).join(" ")}
                                        {...props}
                                      >
                                        {children}
                                      </p>
                                    );
                                  },
                                  ul: ({ node, className, ...props }) => (
                                    <ul className={["my-2 pl-5 list-disc", className].filter(Boolean).join(" ")} {...props} />
                                  ),
                                  ol: ({ node, className, ...props }) => (
                                    <ol className={["my-2 pl-5 list-decimal", className].filter(Boolean).join(" ")} {...props} />
                                  ),
                                  li: ({ node, children, className, ...props }) => {
                                    return (
                                      <li className={["my-1", className].filter(Boolean).join(" ")} {...props}>
                                        {children}
                                      </li>
                                    );
                                  },
                                  table: ({ node, ...props }) => (
                                    <div className="my-3 w-full overflow-x-auto">
                                      <table className="min-w-full table-auto border-collapse" {...props} />
                                    </div>
                                  ),
                                  th: ({ node, ...props }) => (
                                    <th
                                      className="whitespace-nowrap border border-gray-300 bg-gray-100 px-4 py-2 dark:border-gray-700 dark:bg-gray-800"
                                      {...props}
                                    />
                                  ),
                                  td: ({ node, ...props }) => (
                                    <td
                                      className="min-w-[200px] border border-gray-300 px-4 py-2 dark:border-gray-700"
                                      {...props}
                                    />
                                  ),
                                }}
                              >
                                {processContent(preprocessMarkdown(m.content))}
                              </ReactMarkdown>
                            </div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}

                {isThinking || isCitationsPending ? (
                  <motion.div
                    key={isThinking ? "thinking" : "citations-pending"}
                    initial={bubbleMotion.initial}
                    animate={bubbleMotion.animate}
                    exit={bubbleMotion.exit}
                    transition={bubbleMotion.transition}
                    className="flex w-full justify-start"
                  >
                    <div className="max-w-3xl mx-auto w-full -mt-2">
                      <p className="py-2 pl-[52px] text-gray-500 dark:text-gray-400 animate-pulse">
                        {isThinking ? "正在思考..." : "正文已完成，正在整理引用证据..."}
                      </p>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            )}

            <div className="h-40 flex-shrink-0" />
            <div ref={endRef} />
          </div>
        </div>

        <AnimatePresence>
          {selectedEvidence && (
            <>
              <motion.button
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="fixed inset-0 z-30 bg-black/10 dark:bg-black/30"
                onClick={() => setSelectedEvidence(null)}
                aria-label="关闭证据卡"
              />
              <motion.aside
                initial={{ x: 22, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 22, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="fixed right-4 top-[92px] bottom-[112px] z-40 w-[min(430px,calc(100vw-2rem))] rounded-2xl border border-gray-200 bg-white/95 backdrop-blur-xl shadow-[0_12px_36px_rgba(0,0,0,0.16)] dark:border-white/10 dark:bg-[#161719]/95 dark:shadow-[0_12px_36px_rgba(0,0,0,0.55)]"
              >
                <div className="flex h-full flex-col">
                  <div className="flex items-start justify-between border-b border-gray-100 px-4 py-3 dark:border-white/10">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold tracking-wider text-blue-500 dark:text-blue-300">Citation Evidence</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
                        [{selectedEvidence.refNum}] {selectedEvidence.status === "ready" ? selectedEvidence.card?.source : "证据整理中"}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {selectedEvidence.status === "ready"
                          ? typeof selectedEvidence.card?.page === "number"
                            ? `第 ${selectedEvidence.card.page} 页`
                            : "页码未提供"
                          : "正在解析引用对应的文献片段"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedEvidence(null)}
                      className="ml-3 inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/80"
                      aria-label="关闭证据卡"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {selectedEvidence.status === "ready" && selectedEvidence.card ? (
                      <>
                        <section className="space-y-1">
                          <p className="text-[11px] font-semibold tracking-wide text-gray-400 dark:text-white/40">支持句子</p>
                          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-6 text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200">
                            {selectedEvidence.card.supporting_sentence}
                          </div>
                        </section>

                        <section className="space-y-1">
                          <p className="text-[11px] font-semibold tracking-wide text-gray-400 dark:text-white/40">原始片段</p>
                          <div className="rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-3 text-sm leading-6 text-gray-800 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-gray-100">
                            {selectedEvidence.card.source_excerpt}
                          </div>
                        </section>

                        {selectedEvidence.card.shared_concepts.length > 0 && (
                          <section className="space-y-1">
                            <p className="text-[11px] font-semibold tracking-wide text-gray-400 dark:text-white/40">共同概念</p>
                            <div className="flex flex-wrap gap-2">
                              {selectedEvidence.card.shared_concepts.map((term) => (
                                <span
                                  key={term}
                                  className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-1 text-[11px] font-medium text-yellow-800 ring-1 ring-yellow-300 dark:bg-yellow-400/20 dark:text-yellow-100 dark:ring-yellow-300/30"
                                >
                                  {term}
                                </span>
                              ))}
                            </div>
                          </section>
                        )}
                      </>
                    ) : (
                      <section className="flex h-full min-h-[220px] flex-col items-center justify-center gap-4 text-center">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-300">
                          <LoaderCircle className="h-5 w-5 animate-spin" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">证据整理中...</p>
                          <p className="text-xs leading-6 text-gray-500 dark:text-gray-400">
                            引用编号已经识别到，正在等待结构化证据卡完成解析。
                          </p>
                        </div>
                      </section>
                    )}
                  </div>
                </div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <div
          className={`absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-white dark:from-[#131314] to-transparent transition-all duration-1000 ease-[cubic-bezier(0.22,1,0.36,1)] transform-gpu ${
            isTransitioning ? "z-0" : isMenuOpen ? "z-[70]" : "z-20"
          }`}
          style={messages.length === 0 ? { transform: "translateY(calc(182px - 50vh))" } : undefined}
        >
          <div
            className={`${messages.length === 0 ? "max-w-2xl" : "max-w-3xl"} mx-auto relative overflow-visible rounded-[30px] border border-black/[0.05] bg-white/86 shadow-[0_10px_32px_rgba(15,23,42,0.07)] backdrop-blur-2xl transition-colors dark:border-white/[0.07] dark:bg-[#1c1d20]/86 dark:shadow-[0_16px_38px_rgba(0,0,0,0.4)] focus-within:ring-2 focus-within:ring-blue-500/10 dark:focus-within:ring-blue-400/10`}
          >
            <div className="relative z-20 p-3">
              {documents.length > 0 && (
                <div className="flex items-center gap-2 border-b border-black/[0.04] px-2 pb-2 dark:border-white/[0.05]">
                  <span className="shrink-0 text-[10px] font-medium tracking-[0.1em] text-gray-400/95 dark:text-white/28">
                    检索范围
                  </span>
                  <span
                    className="min-w-0 truncate text-[12px] leading-5 text-gray-500 dark:text-white/48"
                    title={selectedDocs.length > 0 ? selectedDocsSummary : "全库检索"}
                  >
                    {selectedDocsPreview}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2.5 pt-2.5">
              <div className="relative flex-shrink-0">
                <button
                  ref={modelMenuButtonRef}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen((v) => !v);
                  }}
                  className="inline-flex h-7.5 items-center gap-1 self-center rounded-full border border-black/[0.04] bg-white/64 px-2 text-[11px] font-medium tracking-[0.01em] text-gray-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] transition hover:border-black/[0.06] hover:bg-white/82 hover:text-gray-700 dark:border-white/[0.05] dark:bg-white/[0.035] dark:text-white/42 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] dark:hover:bg-white/[0.06] dark:hover:text-white/68"
                  aria-label="选择模型"
                >
                  <span className="font-medium text-gray-700 dark:text-white/74">{MODEL_OPTIONS[selectedModel].title}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="relative top-px text-gray-400 dark:text-white/24">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                <AnimatePresence>
                  {isMenuOpen ? (
                    <motion.div
                      ref={modelMenuPanelRef}
                      initial={{ opacity: 0, y: 10, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.98 }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      className="absolute bottom-full left-0 z-[80] mb-2 w-[212px] rounded-3xl border border-black/[0.05] bg-white/92 p-2 shadow-[0_18px_40px_rgba(15,23,42,0.1)] backdrop-blur-2xl dark:border-white/[0.07] dark:bg-[#1b1c1f]/94 dark:shadow-[0_18px_40px_rgba(0,0,0,0.38)]"
                    >
                      {(["speed", "pro"] as const).map((key) => {
                        const opt = MODEL_OPTIONS[key];
                        const active = selectedModel === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => {
                              setSelectedModel(key);
                              setIsMenuOpen(false);
                            }}
                            className={`w-full rounded-2xl px-3 py-2.5 text-left transition ${
                              active
                                ? "bg-gray-100/95 dark:bg-white/[0.08]"
                                : "hover:bg-black/[0.035] dark:hover:bg-white/[0.04]"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{opt.title}</div>
                                <div className="mt-0.5 text-[11px] leading-5 text-gray-500 dark:text-gray-400">{opt.desc}</div>
                              </div>
                              {active ? (
                                <span className="mt-0.5 inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-600 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-300" aria-hidden="true">
                                  Active
                                </span>
                              ) : (
                                <span className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-gray-300 dark:text-white/16" aria-hidden="true">
                                  Idle
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={selectedModel === "pro" ? "Ask Orbit Pro..." : "Ask Orbit..."}
                className="max-h-40 min-h-[44px] flex-1 resize-none overflow-y-auto bg-transparent px-2 py-[9px] text-[17px] leading-7 text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-white/24"
              />
              <button
                type="button"
                onClick={isThinking || isCitationsPending ? handleStop : () => void send()}
                disabled={!(isThinking || isCitationsPending) && (documents.length === 0 || !input.trim())}
                className={`inline-flex h-10.5 w-10.5 items-center justify-center rounded-full bg-[#c7cad2] text-white shadow-[0_6px_14px_rgba(15,23,42,0.08)] transition enabled:hover:bg-[#b3b7c0] disabled:cursor-not-allowed disabled:opacity-35 dark:bg-white/78 dark:text-black dark:enabled:hover:bg-white/88 ${
                  isThinking || isCitationsPending ? "enabled:hover:shadow-[0_0_0_5px_rgba(239,68,68,0.1)]" : ""
                }`}
                aria-label={isThinking || isCitationsPending ? "停止生成" : "发送"}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {isThinking || isCitationsPending ? (
                    <motion.span
                      key="stop"
                      initial={{ opacity: 0, scale: 0.92, rotate: -8 }}
                      animate={{ opacity: 1, scale: 1, rotate: 0 }}
                      exit={{ opacity: 0, scale: 0.92, rotate: 8 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="inline-flex"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="7" y="7" width="10" height="10" rx="2" />
                      </svg>
                    </motion.span>
                  ) : (
                    <motion.span
                      key="send"
                      initial={{ opacity: 0, scale: 0.92, rotate: 8 }}
                      animate={{ opacity: 1, scale: 1, rotate: 0 }}
                      exit={{ opacity: 0, scale: 0.92, rotate: -8 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="inline-flex"
                    >
                      <Send className="h-4 w-4" />
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
              </div>
            </div>
          </div>

          {/* Orbit+ Navigation Entry */}
          <div
            className={`mt-3 flex justify-center transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              messages.length === 0 ? "opacity-100 translate-y-0" : "opacity-0 pointer-events-none translate-y-2"
            }`}
          >
            <button
              type="button"
              onClick={handleOrbitPlusTransition}
              className="group inline-flex items-center gap-2 rounded-2xl bg-white/60 dark:bg-white/[0.05] px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-white/50 ring-1 ring-black/5 dark:ring-white/8 backdrop-blur-sm shadow-sm transition-all duration-200 hover:bg-white/80 dark:hover:bg-white/[0.09] hover:text-gray-900 dark:hover:text-white/80 hover:ring-black/10 dark:hover:ring-white/15 hover:shadow-md"
            >
              <Sparkles className="h-3.5 w-3.5 text-violet-500 dark:text-violet-400 transition-transform duration-300 group-hover:scale-110" />
              <span>Orbit<span className="font-semibold text-violet-500 dark:text-violet-400">+</span></span>
              <span className="text-gray-400 dark:text-white/25">·</span>
              <span className="text-xs text-gray-400 dark:text-white/35">多智能体灵感熔炉</span>
              <svg
                className="h-3 w-3 text-gray-400 dark:text-white/25 transition-transform duration-200 group-hover:translate-x-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Dark overlay — z-[15], BELOW heading z-20, above page content ── */}
      {/* No Orbit text here. The real heading IS the animated element.       */}
      <motion.div
        className={`fixed inset-0 z-[15] pointer-events-none`}
        style={{ backgroundColor: "#0d0e10" }}
        initial={{ opacity: 0 }}
        animate={overlayAnim}
      >
        {/* Subtle violet glow behind the Orbit text */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div style={{
            width: 480, height: 240,
            background: "radial-gradient(ellipse, rgba(139,92,246,0.18) 0%, transparent 70%)",
            filter: "blur(56px)",
          }} />
        </div>
      </motion.div>

      {/* ── Orbit Aura World ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {isAuraOpen && (
          <motion.div
            className="fixed inset-0 z-[400] flex flex-col overflow-hidden"
            initial={{ clipPath: "circle(0% at 50% 36%)" }}
            animate={{ clipPath: "circle(150% at 50% 36%)" }}
            exit={{ clipPath: "circle(0% at 50% 36%)" }}
            transition={{ duration: 0.68, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* 暖调环境背景 */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(160deg, #FFFCF7 0%, #FEF8FF 38%, #F7F2FF 68%, #FFF8F0 100%)",
              }}
            />

            {/* 漂浮光晕层 */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              <div
                className="absolute top-[8%] left-[14%] w-[480px] h-[480px] rounded-full"
                style={{
                  background: "radial-gradient(circle, rgba(251,191,36,0.18) 0%, transparent 65%)",
                  filter: "blur(80px)",
                  animation: "aura-float 22s ease-in-out infinite",
                }}
              />
              <div
                className="absolute bottom-[12%] right-[8%] w-[400px] h-[400px] rounded-full"
                style={{
                  background: "radial-gradient(circle, rgba(196,181,253,0.22) 0%, transparent 65%)",
                  filter: "blur(70px)",
                  animation: "aura-float 28s ease-in-out infinite reverse",
                }}
              />
              <div
                className="absolute top-[50%] left-[50%] w-[320px] h-[320px] rounded-full"
                style={{
                  background: "radial-gradient(circle, rgba(253,164,175,0.16) 0%, transparent 65%)",
                  filter: "blur(60px)",
                  animation: "aura-float 19s ease-in-out infinite 6s",
                }}
              />
            </div>

            {/* 返回按钮 */}
            <motion.button
              type="button"
              onClick={handleExitAura}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.45, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="absolute top-5 left-5 z-20 flex items-center gap-2 px-4 py-2 rounded-full
                bg-white/60 backdrop-blur-md ring-1 ring-amber-200/60 shadow-sm
                text-sm font-medium text-stone-600 hover:text-stone-900
                hover:bg-white/85 hover:ring-amber-300/70
                transition-all duration-250 select-none active:scale-[0.97]"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 12H5M12 5l-7 7 7 7" />
              </svg>
              返回 Orbit
            </motion.button>

            {/* Aura 标题区 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.26, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 flex flex-col items-center pt-14 pb-3 flex-shrink-0"
            >
              <p className="text-[1.6rem] font-light tracking-[0.08em] text-stone-700">
                Orbit{" "}
                <span
                  className="font-semibold"
                  style={{
                    background: "linear-gradient(135deg, #d97706 0%, #a855f7 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                  }}
                >
                  Aura
                </span>
              </p>
              <p className="mt-1.5 text-xs tracking-[0.22em] text-stone-400 uppercase font-light">
                你的感性伙伴
              </p>
            </motion.div>

            {/* 消息流 */}
            <div className="relative z-10 flex-1 overflow-y-auto px-6 py-4">
              <div className="max-w-xl mx-auto flex flex-col gap-8 min-h-full">
                {/* 无消息时的欢迎语 */}
                {auraMessages.length === 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.65, duration: 0.9 }}
                    className="flex flex-col items-center justify-center flex-1 pt-12 text-center gap-4"
                  >
                    <p className="text-[1.75rem] font-extralight text-stone-600 leading-[2]">
                      你好，我在这里。
                    </p>
                    <p className="text-sm font-light text-stone-400 tracking-wider">
                      想说什么都可以
                    </p>
                    {/* 三个呼吸小圆点装饰 */}
                    <div className="flex gap-2 mt-2">
                      {[0, 0.4, 0.8].map((delay) => (
                        <span
                          key={delay}
                          className="w-1 h-1 rounded-full bg-amber-400/50"
                          style={{ animation: `aura-breathe-dot 2.4s ease-in-out ${delay}s infinite` }}
                        />
                      ))}
                    </div>
                  </motion.div>
                )}

                <AnimatePresence initial={false}>
                  {auraMessages.map((m, i) => {
                    const isUser = m.role === "user";
                    const isLastAssistant =
                      !isUser && i === auraMessages.length - 1;
                    return (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: 16, filter: "blur(5px)" }}
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                        className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                      >
                        {isUser ? (
                          <div
                            className="max-w-[72%] text-sm font-light leading-7 tracking-wide
                              bg-white/65 backdrop-blur-sm rounded-2xl rounded-br-md
                              px-4 py-2.5 ring-1 ring-amber-200/50 shadow-sm
                              text-stone-700 text-right"
                          >
                            {m.content}
                          </div>
                        ) : (
                          <div className="max-w-[84%] text-[1.05rem] font-light text-stone-700 leading-[1.95] tracking-wide">
                            {m.content ? (
                              m.content
                            ) : isLastAssistant && isAuraThinking ? (
                              <span className="inline-flex gap-2 items-center pt-2">
                                {[0, 160, 320].map((delay) => (
                                  <span
                                    key={delay}
                                    className="w-1.5 h-1.5 rounded-full bg-amber-400/70 animate-bounce"
                                    style={{ animationDelay: `${delay}ms` }}
                                  />
                                ))}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>

                <div ref={auraEndRef} className="h-4 flex-shrink-0" />
              </div>
            </div>

            {/* 无边框输入区 */}
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 px-6 pb-10 flex-shrink-0"
            >
              <div className="max-w-xl mx-auto">
                {/* 输入框容器：毛玻璃卡片 */}
                <div
                  className="relative rounded-2xl bg-white/55 backdrop-blur-md
                    ring-1 ring-amber-200/60 shadow-sm
                    px-5 pt-4 pb-4 transition-shadow duration-300
                    focus-within:ring-amber-300/80 focus-within:shadow-[0_0_0_3px_rgba(251,191,36,0.10)]"
                >
                  <textarea
                    ref={auraInputRef}
                    value={auraInput}
                    onChange={(e) => {
                      setAuraInput(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void sendAuraMessage();
                      }
                    }}
                    placeholder="对我说些什么…"
                    rows={1}
                    className="w-full resize-none bg-transparent outline-none
                      text-base text-stone-700 placeholder:text-stone-400/70
                      leading-7 pr-14 overflow-hidden"
                    style={{ fontWeight: 300, letterSpacing: "0.03em" }}
                  />
                  {/* 发送按钮 */}
                  <AnimatePresence>
                    {auraInput.trim() ? (
                      <motion.button
                        key="send"
                        initial={{ opacity: 0, scale: 0.75 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.75 }}
                        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                        type="button"
                        onClick={() => void sendAuraMessage()}
                        className="absolute right-4 bottom-3.5 flex items-center justify-center
                          w-8 h-8 rounded-full
                          bg-gradient-to-br from-amber-400 to-violet-400
                          text-white shadow-sm
                          hover:from-amber-500 hover:to-violet-500
                          transition-all duration-200 active:scale-90"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </motion.button>
                    ) : (
                      <motion.div
                        key="hint"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="absolute right-4 bottom-4 text-[11px] text-stone-400/60 select-none pointer-events-none"
                      >
                        Enter 发送
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* ──────────────────────────────────────────────────────────────────── */}
    </div>
  );
}
