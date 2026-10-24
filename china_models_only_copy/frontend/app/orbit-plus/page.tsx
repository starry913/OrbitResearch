"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import {
  BookOpen, Bot, ChevronDown, ChevronLeft, Moon, Rocket, Send, Sun, Swords, Trash2, Upload, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

const API_BASE = "http://localhost:8000";

// ─── Types & Data ─────────────────────────────────────────────────────────────

type RoleKey   = "proposer" | "critic" | "planner";
type TargetKey = RoleKey;
type DriveMode = "manual" | "auto";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

const MODEL_LIST = [
  // ── DeepSeek（官方直连）──────────────────────────────────────────────────────
  { id: "deepseek-reasoner",     label: "DeepSeek R1 v3.1",     shortLabel: "DS-R1",    desc: "数学逻辑推理·性价比之王"         },
  { id: "deepseek-chat",         label: "DeepSeek Chat v3.1",   shortLabel: "DS-Chat",  desc: "流畅对话·极低 API 价格"          },
  // ── Kimi（Moonshot 官方直连）─────────────────────────────────────────────────
  { id: "kimi-k2.5-thinking",    label: "Kimi K2.5 思考版",      shortLabel: "K2.5-T",   desc: "深度推理·慢思考·复杂问题首选"    },
  { id: "kimi-k2.5",            label: "Kimi K2.5",             shortLabel: "K2.5",     desc: "高效对话·极强长文本理解"         },
  // ── Qwen（阿里云 DashScope 直连）─────────────────────────────────────────────
  { id: "qwen3.5-plus",          label: "Qwen3.5 Plus",         shortLabel: "Q3.5+",    desc: "通义·旗舰推理·长文本处理"        },
  { id: "qwen3.5-flash",         label: "Qwen3.5 Flash",        shortLabel: "Q3.5F",    desc: "通义·极速轻量·高频对话"          },
  // ── OpenAI（via API2D）───────────────────────────────────────────────────────
  { id: "gpt-5.4",               label: "GPT-5.4",              shortLabel: "GPT-5.4",  desc: "标准版·速度与智慧均衡"           },
  { id: "gpt-5-nano",            label: "GPT-5 Nano",           shortLabel: "5-Nano",   desc: "极速轻量·高频小任务"             },
  // ── Anthropic（via API2D）────────────────────────────────────────────────────
  { id: "claude-opus-4-6",       label: "Claude Opus 4.6",      shortLabel: "Opus 4.6", desc: "顶级推理·复杂任务首选"           },
  { id: "claude-sonnet-4-6",     label: "Claude Sonnet 4.6",    shortLabel: "Sonnet 4.6",   desc: "干活最顺手·强 Agent 能力"        },
  { id: "claude-haiku-4-5",      label: "Claude Haiku 4.5",     shortLabel: "Haiku 4.5",desc: "极速响应·轻量高效"               },
  // ── Google Gemini（via API2D）─────────────────────────────────────────────────
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro",      shortLabel: "G3.1P",    desc: "超低延迟·海量上下文处理"        },
  { id: "gemini-2.5-flash",       label: "Gemini 2.5 Flash",    shortLabel: "G2.5F",    desc: "极速稳定·全球综合排名前三"      },
];

const ROLE_CONFIG: Record<RoleKey, { label: string; tag: string; tagLight: string; tagDark: string; desc: string }> = {
  proposer: {
    label: "提案大模型", tag: "AI-1",
    tagLight: "bg-violet-100 text-violet-600 ring-violet-200",
    tagDark:  "bg-violet-500/15 text-violet-400 ring-violet-500/30",
    desc: "负责提 Idea，开脑洞，输出初始灵感",
  },
  critic: {
    label: "评审大模型", tag: "AI-2",
    tagLight: "bg-rose-100 text-rose-600 ring-rose-200",
    tagDark:  "bg-rose-500/15 text-rose-400 ring-rose-500/30",
    desc: "负责毒舌批判，找漏洞，挑战假设",
  },
  planner: {
    label: "拆解大模型", tag: "AI-3",
    tagLight: "bg-emerald-100 text-emerald-600 ring-emerald-200",
    tagDark:  "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
    desc: "负责具体规划，拆步骤，制执行路线",
  },
};

const TARGET_OPTIONS: { key: TargetKey; label: string; dot: string; text: string }[] = [
  { key: "proposer", label: "给 AI-1 下达方向", dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-300" },
  { key: "critic",   label: "让 AI-2 开始评审", dot: "bg-rose-500",   text: "text-rose-600 dark:text-rose-300"   },
  { key: "planner",  label: "呼叫 AI-3 拆解",   dot: "bg-emerald-500",text: "text-emerald-600 dark:text-emerald-300" },
];

const AUTO_TURN_OPTIONS = [2, 4, 6, 8, 10, 12, 15, 20] as const;

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extractSseEvents(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: Array<{ event: string; data: string }> = [];

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

// ─── Animation presets ───────────────────────────────────────────────────────

const fadeSlide = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  exit:    { opacity: 0, y: -10 },
  transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
};

// ─── ModelSelect ─────────────────────────────────────────────────────────────

function ModelSelect({
  roleKey, value, onChange,
}: { roleKey: RoleKey; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const role    = ROLE_CONFIG[roleKey];
  const selected = MODEL_LIST.find((m) => m.id === value) ?? MODEL_LIST[0];

  return (
    <div className="relative flex flex-col gap-3 rounded-2xl bg-gray-50 dark:bg-white/5 p-4 ring-1 ring-gray-200 dark:ring-white/8 transition-all hover:bg-gray-100/70 dark:hover:bg-white/[0.07]">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-[11px] font-semibold ring-1 ${role.tagLight} dark:${role.tagDark}`}>
            {role.tag}
          </span>
          <span className="text-sm font-medium text-gray-700 dark:text-white/80">{role.label}</span>
        </div>
        <p className="text-xs text-gray-400 dark:text-white/40 leading-relaxed">{role.desc}</p>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-xl bg-white dark:bg-white/[0.06] px-3.5 py-2.5 text-sm ring-1 ring-gray-200 dark:ring-white/10 transition hover:ring-gray-300 dark:hover:ring-white/20"
      >
        <div className="flex flex-col items-start gap-0.5">
          <span className="font-medium text-gray-900 dark:text-white/90">{selected.label}</span>
          <span className="text-[11px] text-gray-400 dark:text-white/40">{selected.desc}</span>
        </div>
        <ChevronDown className={`h-4 w-4 flex-shrink-0 text-gray-400 dark:text-white/40 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
            className="absolute left-0 right-0 top-full z-[9999] mt-1.5 overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#1c1d20] shadow-xl dark:shadow-2xl shadow-black/8 dark:shadow-black/60"
          >
            {MODEL_LIST.map((m) => {
              const active = m.id === value;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onChange(m.id); setOpen(false); }}
                  className={`flex w-full items-center justify-between px-4 py-3 text-left transition ${
                    active
                      ? "bg-violet-50 dark:bg-white/8 text-gray-900 dark:text-white"
                      : "text-gray-600 dark:text-white/60 hover:bg-gray-50 dark:hover:bg-white/5"
                  }`}
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{m.label}</span>
                    <span className="text-[11px] text-gray-400 dark:text-white/35">{m.desc}</span>
                  </div>
                  {active && (
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-violet-500">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, bubbleClass }: { msg: ChatMessage; bubbleClass: string }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm whitespace-pre-wrap tracking-[-0.01em]
          bg-gradient-to-br from-violet-100/90 via-indigo-50/80 to-purple-50/70
          dark:from-indigo-400/[0.18] dark:via-violet-400/[0.12] dark:to-purple-300/[0.08]
          text-gray-900 dark:text-white
          ring-1 ring-purple-200/60 dark:ring-white/[0.1]
          shadow-sm shadow-purple-100/80 dark:shadow-none
          backdrop-blur-md">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className={`max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm ${bubbleClass}`}>
        <div className="prose prose-sm dark:prose-invert max-w-none
          prose-p:my-1 prose-p:leading-relaxed prose-p:text-[0.875rem]
          prose-headings:mt-3 prose-headings:mb-1 prose-headings:font-semibold
          prose-ul:my-1 prose-ul:pl-4 prose-li:my-0.5
          prose-ol:my-1 prose-ol:pl-4
          prose-strong:font-semibold
          prose-code:text-[0.8em] prose-code:bg-black/10 dark:prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
          prose-pre:text-xs prose-pre:bg-black/10 dark:prose-pre:bg-white/5 prose-pre:rounded-xl prose-pre:p-3
          prose-hr:my-2
          [&_*]:text-gray-900 dark:[&_*]:text-white/95">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {msg.content || "▋"}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// ─── Left Drawer: Knowledge Base ──────────────────────────────────────────────

function LeftDrawer({
  open,
  onClose,
  selectedDocs,
  onToggleDoc,
}: {
  open: boolean;
  onClose: () => void;
  selectedDocs: string[];
  onToggleDoc: (name: string) => void;
}) {
  const [docs,        setDocs       ] = useState<string[]>([]);
  const [isLoading,   setIsLoading  ] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingDoc, setDeletingDoc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/documents`);
      if (res.ok) setDocs((await res.json() as string[]).sort());
    } catch { /* ignore */ }
    setIsLoading(false);
  };

  useEffect(() => { if (open) void fetchDocs(); }, [open]);

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) { e.target.value = ""; return; }
    setIsUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/upload`, { method: "POST", body: fd });
      if (res.ok) await fetchDocs();
    } catch { /* ignore */ }
    setIsUploading(false);
    e.target.value = "";
  };

  const handleDelete = async (name: string) => {
    setDeletingDoc(name);
    try {
      await fetch(`${API_BASE}/documents/${encodeURIComponent(name)}`, { method: "DELETE" });
      setDocs((prev) => prev.filter((d) => d !== name));
    } catch { /* ignore */ }
    setDeletingDoc(null);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-30 bg-black/8 dark:bg-black/25"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: -300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }}
            className="fixed left-0 top-[53px] bottom-[128px] z-40 flex w-72 flex-col overflow-hidden rounded-r-3xl border-r border-y border-gray-200/80 dark:border-white/10 bg-white/95 dark:bg-[#111]/92 shadow-2xl backdrop-blur-xl"
          >
            {/* Header */}
            <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-100 dark:border-white/[0.06] px-4 py-3">
              <div className="flex items-center gap-2">
                <BookOpen className="h-3.5 w-3.5 text-blue-400" />
                <span className="text-sm font-semibold text-gray-800 dark:text-white/80">本地知识库</span>
                <span className="rounded-md bg-gray-100 dark:bg-white/[0.07] px-1.5 py-0.5 text-[9px] font-bold text-gray-500 dark:text-white/40">RAG</span>
              </div>
              <button type="button" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded-lg text-gray-400 dark:text-white/30 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-600 transition">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Status pill */}
            <div className="flex-shrink-0 px-4 pt-3.5">
              <div className="flex items-center gap-2 rounded-xl bg-gray-50 dark:bg-white/[0.04] px-3 py-2.5 ring-1 ring-gray-200 dark:ring-white/[0.07]">
                {isLoading
                  ? <span className="h-3 w-3 rounded-full border-2 border-blue-300/40 border-t-blue-400 animate-spin flex-shrink-0" />
                  : <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400 animate-pulse" />
                }
                <span className="text-xs text-gray-500 dark:text-white/45 font-medium">
                  {isLoading ? "加载中…" : `已加载 ${docs.length} 篇 RAG 参考文献`}
                </span>
              </div>
            </div>

            {/* Doc list */}
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
              {!isLoading && docs.length === 0 && (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 dark:border-white/[0.08] px-3 py-6 text-center">
                  <BookOpen className="h-6 w-6 text-gray-300 dark:text-white/20" />
                  <p className="text-xs text-gray-400 dark:text-white/30">暂无文献</p>
                  <p className="text-[10px] text-gray-300 dark:text-white/20">上传 PDF 后，AI-1 将在 RAG 模式下引用</p>
                </div>
              )}
              {docs.map((name) => {
                const checked = selectedDocs.includes(name);
                return (
                <div
                  key={name}
                  className={`group flex items-start gap-2.5 rounded-xl px-3.5 py-3 ring-1 transition ${
                    checked
                      ? "bg-blue-50/80 ring-blue-200 dark:bg-blue-500/10 dark:ring-blue-400/30"
                      : "bg-gray-50 dark:bg-white/[0.04] ring-gray-200 dark:ring-white/[0.07] hover:ring-gray-300 dark:hover:ring-white/[0.12]"
                  }`}
                >
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-white dark:bg-white/[0.08] ring-1 ring-gray-200 dark:ring-white/[0.08] mt-0.5">
                    <span className="text-[10px] font-bold text-gray-400 dark:text-white/30">PDF</span>
                  </div>
                  <label className="flex flex-1 min-w-0 cursor-pointer items-start gap-2.5">
                    <span className="relative mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleDoc(name)}
                        className="peer sr-only"
                      />
                      <span className={`h-4 w-4 rounded-md border transition ${
                        checked
                          ? "border-blue-500 bg-blue-500 dark:border-blue-400 dark:bg-blue-400"
                          : "border-gray-300 bg-white dark:border-white/20 dark:bg-white/[0.04]"
                      }`} />
                      <svg
                        viewBox="0 0 24 24"
                        className={`pointer-events-none absolute h-3 w-3 transition ${
                          checked ? "scale-100 text-white opacity-100" : "scale-75 text-transparent opacity-0"
                        }`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                    <span className="flex-1 min-w-0 text-xs font-medium text-gray-800 dark:text-white/75 leading-snug break-all">
                      {name.replace(/\.pdf$/i, "")}
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleDelete(name)}
                    disabled={deletingDoc === name}
                    className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-md text-gray-300 dark:text-white/20 opacity-0 group-hover:opacity-100 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40 transition"
                    title="删除"
                  >
                    {deletingDoc === name
                      ? <span className="h-3 w-3 rounded-full border border-red-300 border-t-red-500 animate-spin" />
                      : <Trash2 className="h-3 w-3" />
                    }
                  </button>
                </div>
              )})}
            </div>

            {docs.length > 0 && (
              <div className="flex-shrink-0 px-4 pb-3">
                <div className="rounded-xl bg-gray-50 dark:bg-white/[0.04] px-3 py-2 ring-1 ring-gray-200 dark:ring-white/[0.07]">
                  <span className="text-[11px] text-gray-500 dark:text-white/40">
                    {selectedDocs.length > 0 ? `当前已限定 ${selectedDocs.length} 篇文献供 AI-1 检索` : "未限定时，AI-1 默认在整个知识库中检索"}
                  </span>
                </div>
              </div>
            )}

            {/* Upload button */}
            <div className="flex-shrink-0 px-4 pb-4">
              <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleUpload} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-gray-300 dark:border-white/15 px-3 py-2.5 text-xs text-gray-400 dark:text-white/30 transition hover:border-blue-400 dark:hover:border-blue-500/50 hover:text-blue-500 dark:hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isUploading
                  ? <><span className="h-3 w-3 rounded-full border-2 border-blue-300/40 border-t-blue-400 animate-spin" />上传中…</>
                  : <><Upload className="h-3 w-3" />上传 PDF 文献</>
                }
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── Right Drawer: AI-3 Architect ─────────────────────────────────────────────

function RightDrawer({
  open, onClose, messages, modelLabel,
}: { open: boolean; onClose: () => void; messages: ChatMessage[]; modelLabel: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-30 bg-black/8 dark:bg-black/25"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: 560, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 560, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }}
            className="fixed right-0 top-[53px] bottom-[128px] z-40 flex w-[min(560px,48vw)] flex-col overflow-hidden rounded-l-3xl border-l border-y border-gray-200/80 dark:border-white/[0.08] bg-white/98 dark:bg-[#0f1011]/95 shadow-2xl backdrop-blur-xl"
          >
            <div className="flex flex-shrink-0 items-center justify-between border-b border-t-[2px] border-gray-100 dark:border-white/[0.06] border-t-teal-300/70 dark:border-t-teal-400/35 px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-teal-400/10 dark:bg-teal-400/10">
                  <Bot className="h-3.5 w-3.5 text-teal-500 dark:text-teal-400" />
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-gray-800 dark:text-white/80">AI-3 架构师参谋</span>
                  <span className="text-[10px] text-gray-400 dark:text-white/30">{modelLabel}</span>
                </div>
              </div>
              <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-xl text-gray-400 dark:text-white/30 hover:bg-gray-100 dark:hover:bg-white/[0.08] hover:text-gray-600 transition">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50 dark:bg-white/[0.04] ring-1 ring-gray-100 dark:ring-white/[0.07]">
                      <span className="text-xl">🛠</span>
                    </div>
                    <p className="text-sm text-gray-400 dark:text-white/25">等待呼叫 AI-3 拆解...</p>
                    <p className="text-xs text-gray-300 dark:text-white/15">切换到「呼叫 AI-3 拆解」后发送指令</p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {messages.map((msg) => (
                    <MessageBubble
                      key={msg.id} msg={msg}
                      bubbleClass="bg-white dark:bg-white/[0.04] text-gray-900 dark:text-white/95 border border-gray-100 dark:border-white/[0.07] border-l-[3px] border-l-teal-300 dark:border-l-teal-400/60"
                    />
                  ))}
                  <div ref={endRef} />
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── Director's Console ───────────────────────────────────────────────────────

function DirectorsConsole({
  models,
  target,
  onTargetChange,
  input,
  onInputChange,
  onSend,
  isStreaming,
  driveMode,
  onDriveModeChange,
  autoTurns,
  onAutoTurnsChange,
}: {
  models: Record<RoleKey, string>;
  target: TargetKey;
  onTargetChange: (t: TargetKey) => void;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  isStreaming?: boolean;
  driveMode: DriveMode;
  onDriveModeChange: (mode: DriveMode) => void;
  autoTurns: number;
  onAutoTurnsChange: (turns: number) => void;
}) {
  const [targetOpen, setTargetOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentTarget = TARGET_OPTIONS.find((t) => t.key === target)!;
  const shortLabel = (role: TargetKey) => MODEL_LIST.find((m) => m.id === models[role])?.shortLabel ?? models[role];

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onInputChange(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center px-6 pb-5 pt-2 pointer-events-none">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }}
        className="w-full max-w-lg pointer-events-auto"
      >
        {/* Floating pill card */}
        <div className="rounded-[26px] bg-white/96 dark:bg-[#1c1c1e]/96 backdrop-blur-2xl ring-1 ring-black/[0.07] dark:ring-white/[0.09] shadow-[0_4px_32px_rgba(0,0,0,0.10),0_1px_6px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_40px_rgba(0,0,0,0.55)] px-4 pt-2.5 pb-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onDriveModeChange("manual")}
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                driveMode === "manual"
                  ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                  : "bg-gray-100/90 text-gray-500 dark:bg-white/[0.07] dark:text-white/40"
              }`}
            >
              手动挡
            </button>
            <button
              type="button"
              onClick={() => onDriveModeChange("auto")}
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                driveMode === "auto"
                  ? "bg-violet-600 text-white dark:bg-violet-500"
                  : "bg-gray-100/90 text-gray-500 dark:bg-white/[0.07] dark:text-white/40"
              }`}
            >
              自动挡
            </button>

            {driveMode === "auto" && (
              <>
                <span className="text-[10px] text-gray-400 dark:text-white/25">交流轮数</span>
                <div className="inline-flex items-center gap-1 rounded-full bg-gray-100/90 px-1 py-1 dark:bg-white/[0.07]">
                  {AUTO_TURN_OPTIONS.map((turns) => (
                    <button
                      key={turns}
                      type="button"
                      onClick={() => onAutoTurnsChange(turns)}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${
                        autoTurns === turns
                          ? "bg-violet-600 text-white dark:bg-violet-500"
                          : "text-gray-500 dark:text-white/40"
                      }`}
                    >
                      {turns}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Target chip row — no label, just the compact pill */}
          <div className="relative mb-1.5">
            <button
              type="button"
              onClick={() => setTargetOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-full bg-gray-100/80 dark:bg-white/[0.07] px-2.5 py-1 text-[11px] font-medium text-gray-600 dark:text-white/50 transition hover:bg-gray-200/80 dark:hover:bg-white/[0.1] active:scale-[0.97]"
            >
              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${currentTarget.dot}`} />
              <span>{driveMode === "auto" && target !== "planner" ? "自动串联 A1 / A2" : currentTarget.label}</span>
              <span className="text-gray-400 dark:text-white/30">
                · {driveMode === "auto" && target !== "planner" ? `${shortLabel("proposer")} × ${shortLabel("critic")}` : shortLabel(target)}
              </span>
              <ChevronDown className={`h-3 w-3 text-gray-400 dark:text-white/25 transition-transform duration-150 ${targetOpen ? "rotate-180" : ""}`} />
            </button>

            <AnimatePresence>
              {targetOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 4, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.97 }}
                  transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
                  className="absolute bottom-full left-0 z-[9999] mb-2 w-52 overflow-hidden rounded-2xl border border-gray-100 dark:border-white/[0.09] bg-white/98 dark:bg-[#2c2c2e]/98 shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl"
                >
                  {TARGET_OPTIONS.map((opt) => {
                    const disabled = driveMode === "auto" && opt.key === "critic";
                    return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => {
                        if (disabled) return;
                        onTargetChange(opt.key);
                        setTargetOpen(false);
                      }}
                      disabled={disabled}
                      className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition hover:bg-gray-50 dark:hover:bg-white/[0.05] ${
                        opt.key === target ? "bg-gray-50/80 dark:bg-white/[0.05]" : ""
                      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                    >
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${opt.dot}`} />
                      <div className="flex flex-col min-w-0">
                        <span className={`text-xs font-medium ${opt.text}`}>{opt.label}</span>
                        <span className="text-[10px] text-gray-400 dark:text-white/30 truncate">
                          {disabled ? "自动挡中由系统接管" : shortLabel(opt.key)}
                        </span>
                      </div>
                      {opt.key === target && <span className="ml-auto text-[9px] text-gray-300 dark:text-white/20 flex-shrink-0">当前</span>}
                    </button>
                  )})}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Input + Send */}
          <div className="flex items-end gap-2.5">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={driveMode === "auto" && target !== "planner" ? "输入初始研究任务，系统将自动驱动 AI-1 与 AI-2 对撞…" : "输入指令…"}
              rows={1}
              className="flex-1 resize-none bg-transparent py-1 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/30 outline-none leading-relaxed"
              style={{ maxHeight: "120px", overflowY: "auto" }}
            />
            <button
              type="button"
              onClick={onSend}
              disabled={!input.trim() || isStreaming}
              className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 dark:bg-white text-white dark:text-gray-900 transition-all duration-200 hover:opacity-80 disabled:opacity-25 disabled:cursor-not-allowed active:scale-90"
            >
              {isStreaming
                ? <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 dark:border-gray-900/40 border-t-white dark:border-t-gray-900 animate-spin" />
                : <Send className="h-3.5 w-3.5" />
              }
            </button>
          </div>
        </div>

        <p className="mt-1.5 text-center text-[10px] text-gray-300 dark:text-white/15">
          Shift+Enter 换行 · Enter 发送
        </p>
      </motion.div>
    </div>
  );
}

// ─── Phase 1: Config View ─────────────────────────────────────────────────────

type TestStatus = "idle" | "testing" | "ok" | "error";
type TestResult = { status: TestStatus; msg: string };

const ROLE_COLORS: Record<RoleKey, { dot: string; badge: string; tag: string }> = {
  proposer: { dot: "bg-blue-400",   badge: "bg-gray-50 dark:bg-white/[0.05] text-gray-600 dark:text-white/55 ring-gray-200 dark:ring-white/[0.08]", tag: "AI-1" },
  critic:   { dot: "bg-orange-400", badge: "bg-gray-50 dark:bg-white/[0.05] text-gray-600 dark:text-white/55 ring-gray-200 dark:ring-white/[0.08]", tag: "AI-2" },
  planner:  { dot: "bg-teal-400",   badge: "bg-gray-50 dark:bg-white/[0.05] text-gray-600 dark:text-white/55 ring-gray-200 dark:ring-white/[0.08]", tag: "AI-3" },
};

const INSTRUCTION_PLACEHOLDER: Record<RoleKey, string> = {
  proposer: "例：基于 HCI 领域近 5 年顶会文献，聚焦触觉反馈或多模态交互方向，提出一个具体且可实验验证的研究 Idea。",
  critic:   "例：以 CHI / UIST 等 CCF-A 级会议评审标准进行审查，重点考察新颖性、技术可行性和用户研究设计。",
  planner:  "例：面向博士生执行，分 3 个月为一阶段规划，优先产出可投稿的预实验结果。",
};

const INSTRUCTION_LABEL: Record<RoleKey, string> = {
  proposer: "AI-1 任务指令",
  critic:   "AI-2 任务指令",
  planner:  "AI-3 任务指令",
};

function ConfigView({
  models, onModelChange, agentInstructions, onInstructionChange, onLaunch, isDark, onToggleDark, fromTransition,
}: {
  models: Record<RoleKey, string>;
  onModelChange: (role: RoleKey) => (v: string) => void;
  agentInstructions: Record<RoleKey, string>;
  onInstructionChange: (role: RoleKey) => (v: string) => void;
  onLaunch: () => void;
  isDark: boolean;
  onToggleDark: () => void;
  fromTransition?: boolean;
}) {
  const [testResults, setTestResults] = useState<Partial<Record<RoleKey, TestResult>>>({});
  const [isTesting,   setIsTesting  ] = useState(false);
  const [showPanel,   setShowPanel  ] = useState(false);

  const runTests = async () => {
    setShowPanel(true);
    setIsTesting(true);
    setTestResults({});

    const roles: RoleKey[] = ["proposer", "critic", "planner"];

    await Promise.all(roles.map(async (role) => {
      setTestResults((p) => ({ ...p, [role]: { status: "testing", msg: "连接中…" } }));
      try {
        const res = await fetch(`${API_BASE}/orbit-chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: models[role],
            role,
            messages: [{ role: "user", content: "用一句话证明你已成功接入 Orbit 系统。" }],
          }),
        });

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => res.statusText);
          setTestResults((p) => ({ ...p, [role]: { status: "error", msg: errText.slice(0, 120) } }));
          return;
        }

        const reader = res.body.getReader();
        const dec    = new TextDecoder();
        let   buf    = "";
        let   reply  = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const d = line.slice("data: ".length);
              if (d === "[DONE]") break;
              reply += d.replace(/\\n/g, "\n");
              setTestResults((p) => ({ ...p, [role]: { status: "testing", msg: reply } }));
            }
          }
        }

        setTestResults((p) => ({ ...p, [role]: { status: "ok", msg: reply || "✓ 响应成功" } }));
      } catch (e) {
        setTestResults((p) => ({ ...p, [role]: { status: "error", msg: "无法连接后端，请确认后端已启动（python main.py）" } }));
      }
    }));

    setIsTesting(false);
  };

  return (
    <motion.div key="config" {...fadeSlide} className="relative z-10 mx-auto max-w-2xl px-4 py-12">
      {/* Nav */}
      <div className="flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-white/40 transition hover:text-gray-800 dark:hover:text-white/70">
          <ChevronLeft className="h-4 w-4" />
          返回 Orbit
        </Link>
        <button
          type="button"
          onClick={onToggleDark}
          className="flex h-8 w-8 items-center justify-center rounded-xl bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/60 transition hover:bg-gray-200 dark:hover:bg-white/15"
          aria-label="切换深浅色"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>

      {/* Header — 三段错开浮现；整块在栏内水平居中，与视口中心光晕对齐（避免 max-w 栏内默认左对齐显得「太靠左」） */}
      <div className="mt-10 mb-10 flex flex-col items-center text-center">
        {/* Orbit+ h1：与主页 Orbit 完全相同的样式（渐变色 + font-bold），视觉上是"同一个元素" */}
        <motion.h1
          className="text-3xl font-bold tracking-tight mb-3 inline-flex items-baseline justify-center gap-0.5"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.38, delay: fromTransition ? 0.15 : 0.05,
            ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
        >
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-500 to-purple-500">Orbit</span>
          <span style={{ color: "#a78bfa" }}>+</span>
        </motion.h1>

        {/* BETA badge + MULTI-AGENT */}
        <motion.div
          className="flex flex-wrap items-center justify-center gap-3 mb-2"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.38, delay: fromTransition ? 0.38 : 0.1,
            ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
        >
          <span className="inline-flex items-center rounded-xl bg-violet-100 dark:bg-violet-500/15 px-3 py-1 text-xs font-semibold text-violet-600 dark:text-violet-300 ring-1 ring-violet-200 dark:ring-violet-500/30">
            BETA
          </span>
          <span className="text-xs text-gray-400 dark:text-white/30 font-mono tracking-wider">MULTI-AGENT</span>
        </motion.div>

        {/* 副标题 */}
        <motion.p
          className="text-base text-gray-500 dark:text-white/45 leading-relaxed"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.38, delay: fromTransition ? 0.52 : 0.12,
            ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
        >
          多智能体灵感熔炉 · 让三个 AI 互相碰撞，淬炼你的研究想法
        </motion.p>
      </div>

      {/* Config Card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: fromTransition ? 0.68 : 0.1,
          ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
        className="relative z-20 rounded-3xl bg-white dark:bg-white/[0.03] p-6 ring-1 ring-gray-200 dark:ring-white/8 shadow-sm dark:shadow-[0_0_60px_rgba(0,0,0,0.4)]"
      >
        <div className="mb-5 flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-violet-500" />
          <span className="text-xs font-semibold tracking-wider text-gray-400 dark:text-white/40 uppercase">配置智能体阵容</span>
        </div>
        <div className="flex flex-col gap-3">
          {(["proposer", "critic", "planner"] as RoleKey[]).map((role, i) => (
            <motion.div
              key={role}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.15 + i * 0.07, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
              className="relative"
              style={{ zIndex: 30 - i * 10 }}
            >
              <ModelSelect roleKey={role} value={models[role]} onChange={onModelChange(role)} />
            </motion.div>
          ))}
        </div>

        {/* ── 自检按钮 ── */}
        <div className="mt-5 pt-4 border-t border-gray-100 dark:border-white/[0.06]">
          <button
            type="button"
            onClick={runTests}
            disabled={isTesting}
            className="inline-flex items-center gap-2 rounded-xl bg-gray-100 dark:bg-white/8 px-4 py-2 text-xs font-medium text-gray-600 dark:text-white/55 transition hover:bg-gray-200 dark:hover:bg-white/12 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            {isTesting
              ? <span className="h-3 w-3 rounded-full border-2 border-gray-400/40 dark:border-white/20 border-t-gray-500 dark:border-t-white/50 animate-spin" />
              : <span className="text-sm">🔬</span>
            }
            {isTesting ? "自检中…" : "一键节点自检"}
          </button>
          <span className="ml-3 text-[10px] text-gray-400 dark:text-white/20">发送测试消息，验证三个模型是否可正常响应</span>
        </div>

        {/* ── 测试结果面板 ── */}
        <AnimatePresence>
          {showPanel && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
              className="overflow-hidden"
            >
              <div className="mt-4 flex flex-col gap-2">
                {(["proposer", "critic", "planner"] as RoleKey[]).map((role) => {
                  const r = testResults[role];
                  const c = ROLE_COLORS[role];
                  const modelLabel = MODEL_LIST.find((m) => m.id === models[role])?.shortLabel ?? models[role];
                  return (
                    <div key={role} className="rounded-xl bg-gray-50 dark:bg-white/[0.03] ring-1 ring-gray-100 dark:ring-white/[0.06] px-3.5 py-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${c.badge}`}>{c.tag}</span>
                        <span className="text-[11px] font-medium text-gray-600 dark:text-white/50">{modelLabel}</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {!r && <span className="text-[10px] text-gray-300 dark:text-white/20">等待测试</span>}
                          {r?.status === "testing" && (
                            <>
                              <span className="h-2 w-2 rounded-full border border-gray-300 dark:border-white/25 border-t-gray-500 dark:border-t-white/60 animate-spin" />
                              <span className="text-[10px] text-gray-400 dark:text-white/30">响应中…</span>
                            </>
                          )}
                          {r?.status === "ok"    && <><span className="h-2 w-2 rounded-full bg-emerald-500" /><span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">连通</span></>}
                          {r?.status === "error" && <><span className="h-2 w-2 rounded-full bg-rose-500"    /><span className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">失败</span></>}
                        </span>
                      </div>
                      {r && r.msg && (
                        <p className={`text-[11px] leading-relaxed line-clamp-3 ${r.status === "error" ? "text-rose-500 dark:text-rose-400" : "text-gray-500 dark:text-white/35"}`}>
                          {r.msg}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Launch */}
      <motion.div
        className="relative z-0 mt-6"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.38, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
      >
        <button
          type="button"
          onClick={onLaunch}
          className="group relative w-full overflow-hidden rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-4 text-base font-semibold text-white shadow-[0_8px_30px_rgba(124,58,237,0.28)] transition-all duration-300 hover:shadow-[0_12px_40px_rgba(124,58,237,0.42)] hover:brightness-110 active:scale-[0.98]"
        >
          <span className="relative z-10 flex items-center justify-center gap-2.5">
            <Rocket className="h-5 w-5 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            阵容确认，进入对撞沙盘
          </span>
          <div className="absolute inset-0 bg-gradient-to-r from-violet-500 to-indigo-500 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        </button>
        <p className="mt-3 text-center text-xs text-gray-400 dark:text-white/25">
          三位 AI 将依次提案 → 批判 → 拆解，形成完整的研究方案
        </p>
      </motion.div>
    </motion.div>
  );
}

// ─── Phase 2: Arena View ──────────────────────────────────────────────────────

function ArenaView({
  models, agentInstructions, onBack, isDark, onToggleDark,
}: {
  models: Record<RoleKey, string>;
  agentInstructions: Record<RoleKey, string>;
  onBack: () => void;
  isDark: boolean;
  onToggleDark: () => void;
}) {
  const [proposerMsgs, setProposerMsgs] = useState<ChatMessage[]>([]);
  const [criticMsgs,   setCriticMsgs  ] = useState<ChatMessage[]>([]);
  const [plannerMsgs,  setPlannerMsgs ] = useState<ChatMessage[]>([]);
  const [leftDrawerOpen,  setLeftDrawerOpen ] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [target, setTarget] = useState<TargetKey>("proposer");
  const [input,  setInput ] = useState("");
  const [driveMode, setDriveMode] = useState<DriveMode>("manual");
  const [autoTurns, setAutoTurns] = useState<number>(3);
  const [streaming, setStreaming] = useState<Partial<Record<RoleKey, boolean>>>({});

  const proposerEndRef = useRef<HTMLDivElement>(null);
  const criticEndRef   = useRef<HTMLDivElement>(null);
  const proposerMsgsRef = useRef<ChatMessage[]>([]);
  const criticMsgsRef = useRef<ChatMessage[]>([]);
  const plannerMsgsRef = useRef<ChatMessage[]>([]);

  useEffect(() => { proposerEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [proposerMsgs]);
  useEffect(() => { criticEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [criticMsgs]);
  useEffect(() => { proposerMsgsRef.current = proposerMsgs; }, [proposerMsgs]);
  useEffect(() => { criticMsgsRef.current = criticMsgs; }, [criticMsgs]);
  useEffect(() => { plannerMsgsRef.current = plannerMsgs; }, [plannerMsgs]);

  const fullLabel  = (role: RoleKey) => MODEL_LIST.find((m) => m.id === models[role])?.label      ?? models[role];
  const shortLabel = (role: RoleKey) => MODEL_LIST.find((m) => m.id === models[role])?.shortLabel ?? models[role];

  const setMsgs   = (role: RoleKey) => role === "proposer" ? setProposerMsgs : role === "critic" ? setCriticMsgs : setPlannerMsgs;
  const getMsgsRef = (role: RoleKey) => role === "proposer" ? proposerMsgsRef : role === "critic" ? criticMsgsRef : plannerMsgsRef;

  const handleTargetChange = (t: TargetKey) => {
    if (driveMode === "auto" && t === "critic") {
      setTarget("proposer");
      return;
    }
    setTarget(driveMode === "auto" && t !== "planner" ? "proposer" : t);
    if (t === "planner") setRightDrawerOpen(true);
  };

  const toggleDoc = (name: string) => {
    setSelectedDocs((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  };

  const streamRoleReply = async (
    role: RoleKey,
    userContent: string,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> => {
    const setter = setMsgs(role);
    const history = getMsgsRef(role).current;
    const userMsg: ChatMessage = { id: makeId(), role: "user", content: userContent };
    const aiId = makeId();

    setter((prev) => [
      ...prev,
      userMsg,
      { id: aiId, role: "assistant", content: "" },
    ]);
    setStreaming((prev) => ({ ...prev, [role]: true }));

    let fullReply = "";

    try {
      const res = await fetch(`${API_BASE}/orbit-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: models[role],
          role,
          user_instruction: agentInstructions[role] || undefined,
          selected_files: role === "proposer" ? selectedDocs : [],
          messages: [...history, userMsg].map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => res.statusText);
        const message = err || "请求失败";
        setter((prev) => prev.map((m) => (
          m.id === aiId ? { ...m, content: `⚠️ 请求失败：${message}` } : m
        )));
        return { ok: false, error: message };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = extractSseEvents(buffer);
        buffer = parsed.rest;

        let shouldStop = false;
        for (const ev of parsed.events) {
          if (ev.event === "end" && ev.data === "[DONE]") {
            shouldStop = true;
            await reader.cancel();
            break;
          }
          if (ev.event === "error") {
            const message = ev.data || "流式返回错误";
            setter((prev) => prev.map((m) => (
              m.id === aiId ? { ...m, content: m.content || `⚠️ ${message}` } : m
            )));
            return { ok: false, error: message };
          }

          if (!ev.data || ev.event === "meta") continue;
          const token = ev.data.replace(/\\n/g, "\n");
          fullReply += token;
          setter((prev) => prev.map((m) => (
            m.id === aiId ? { ...m, content: m.content + token } : m
          )));
        }

        if (shouldStop) break;
      }
    } catch {
      const message = "网络请求失败，请确认后端是否正在运行";
      setter((prev) => prev.map((m) => (
        m.id === aiId ? { ...m, content: `⚠️ ${message}` } : m
      )));
      return { ok: false, error: message };
    } finally {
      setStreaming((prev) => ({ ...prev, [role]: false }));
    }

    return { ok: true, content: fullReply };
  };

  const buildAutoPrompt = (
    role: "proposer" | "critic",
    seedPrompt: string,
    latestPeerReply: string,
    turnIndex: number,
  ) => {
    if (role === "proposer") {
      return turnIndex === 0
        ? `这是用户给出的研究任务，请先提出你的初版方案：\n\n${seedPrompt}`
        : `下面是用户的原始任务，以及 AI-2 对你上一版方案的批判意见。请你基于这些反馈，给出更强的新一版方案。\n\n【用户原始任务】\n${seedPrompt}\n\n【AI-2 的最新反馈】\n${latestPeerReply}`;
    }

    return `你现在要以严格评审的身份，审查 AI-1 刚刚给出的方案。请抓最关键的问题，保持批判性。\n\n【用户原始任务】\n${seedPrompt}\n\n【AI-1 的最新方案】\n${latestPeerReply}`;
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    const seedPrompt = input.trim();
    const role = driveMode === "auto" && target !== "planner" ? "proposer" : target;
    setInput("");

    if (role === "planner") {
      setRightDrawerOpen(true);
      await streamRoleReply("planner", seedPrompt);
      return;
    }

    if (driveMode === "manual") {
      await streamRoleReply(role, seedPrompt);
      return;
    }

    let latestReply = "";
    for (let turnIndex = 0; turnIndex < autoTurns; turnIndex += 1) {
      const currentRole: "proposer" | "critic" = turnIndex % 2 === 0 ? "proposer" : "critic";
      const prompt = buildAutoPrompt(currentRole, seedPrompt, latestReply, turnIndex);
      const result = await streamRoleReply(currentRole, prompt);

      if (!result.ok) {
        return;
      }

      latestReply = result.content.trim();
      if (!latestReply) {
        return;
      }
    }
  };

  return (
    <motion.div key="arena" {...fadeSlide} className="flex h-screen w-full flex-col overflow-hidden">

      {/* ── Header ── */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 dark:border-white/[0.07] bg-white/95 dark:bg-[#0d0e10]/95 px-5 py-3 backdrop-blur-xl">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-white/35 transition hover:text-gray-800 dark:hover:text-white/65"
        >
          <ChevronLeft className="h-4 w-4" />
          返回重新选角
        </button>

        {/* Lineup badges */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-white/[0.07] px-2.5 py-1 text-[11px] font-semibold text-gray-600 dark:text-white/55 ring-1 ring-gray-200 dark:ring-white/[0.08]">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />AI-1 · {shortLabel("proposer")}
          </span>
          {selectedDocs.length > 0 && (
            <span className="inline-flex items-center rounded-lg bg-blue-50 px-2.5 py-1 text-[10px] font-semibold text-blue-600 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/30">
              RAG 已限定 {selectedDocs.length} 篇
            </span>
          )}
          <Swords className="h-3 w-3 text-gray-300 dark:text-white/15" />
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-white/[0.07] px-2.5 py-1 text-[11px] font-semibold text-gray-600 dark:text-white/55 ring-1 ring-gray-200 dark:ring-white/[0.08]">
            <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />AI-2 · {shortLabel("critic")}
          </span>
          <span className="text-gray-300 dark:text-white/15 text-xs">·</span>
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-white/[0.07] px-2.5 py-1 text-[11px] font-semibold text-gray-600 dark:text-white/55 ring-1 ring-gray-200 dark:ring-white/[0.08]">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />AI-3 · {shortLabel("planner")}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-gray-900 dark:bg-white/[0.08] px-2 py-0.5 text-[10px] font-semibold text-white dark:text-white/70 ring-1 ring-gray-700 dark:ring-white/[0.12]">LIVE</span>
          <button
            type="button"
            onClick={onToggleDark}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/50 transition hover:bg-gray-200 dark:hover:bg-white/15"
            aria-label="切换深浅色"
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* ── Main Content (split panels) ── */}
      <div className="relative flex flex-1 flex-row overflow-hidden">

        {/* Left Panel — AI-1 */}
        <div className="flex flex-1 flex-col overflow-hidden border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-[#111]">
          {/* Panel header */}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-t-[2px] border-gray-100 dark:border-white/[0.05] border-t-blue-300/70 dark:border-t-blue-400/35 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-gray-900 dark:text-white/85">AI-1 提案区</span>
              <span className="text-[10px] text-gray-500 dark:text-white/45">{fullLabel("proposer")}</span>
            </div>
            <button
              type="button"
              onClick={() => setLeftDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-white/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-gray-600 dark:text-white/50 ring-1 ring-gray-200 dark:ring-white/[0.08] transition hover:bg-gray-200 dark:hover:bg-white/[0.1] active:scale-[0.97]"
            >
              <BookOpen className="h-3 w-3" />本地知识库
            </button>
          </div>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5 py-5 pb-40">
            {proposerMsgs.length === 0 ? (
              <div className="flex h-full min-h-[200px] items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50 dark:bg-white/[0.04] ring-1 ring-gray-100 dark:ring-white/[0.07]">
                    <span className="text-xl">💡</span>
                  </div>
                  <p className="text-sm text-gray-400 dark:text-white/25">等待提案...</p>
                  <p className="text-xs text-gray-300 dark:text-white/15">选择「给 AI-1 下达方向」后发送指令</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 mx-auto max-w-xl">
                {proposerMsgs.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg}
                    bubbleClass="bg-white dark:bg-white/[0.04] text-gray-900 dark:text-white/95 border border-gray-100 dark:border-white/[0.07] border-l-[3px] border-l-blue-300 dark:border-l-blue-400/60"
                  />
                ))}
                <div ref={proposerEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Right Panel — AI-2 */}
        <div className="flex flex-1 flex-col overflow-hidden bg-gray-50 dark:bg-[#151515]">
          {/* Panel header */}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-t-[2px] border-gray-100 dark:border-white/[0.05] border-t-orange-300/70 dark:border-t-orange-400/35 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-orange-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-gray-900 dark:text-white/85">AI-2 盲审区</span>
              <span className="text-[10px] text-gray-500 dark:text-white/45">{fullLabel("critic")}</span>
            </div>
            <button
              type="button"
              onClick={() => { setRightDrawerOpen(true); setTarget("planner"); }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-white/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-gray-600 dark:text-white/50 ring-1 ring-gray-200 dark:ring-white/[0.08] transition hover:bg-gray-200 dark:hover:bg-white/[0.1] active:scale-[0.97]"
            >
              <Bot className="h-3 w-3" />呼叫 AI-3 解说
            </button>
          </div>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5 py-5 pb-40">
            {criticMsgs.length === 0 ? (
              <div className="flex h-full min-h-[200px] items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50 dark:bg-white/[0.04] ring-1 ring-gray-100 dark:ring-white/[0.07]">
                    <span className="text-xl">⚔️</span>
                  </div>
                  <p className="text-sm text-gray-400 dark:text-white/25">等待审判...</p>
                  <p className="text-xs text-gray-300 dark:text-white/15">选择「让 AI-2 开始评审」后发送指令</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 mx-auto max-w-xl">
                {criticMsgs.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg}
                    bubbleClass="bg-gray-50 dark:bg-white/[0.03] text-gray-900 dark:text-white/95 border border-gray-100 dark:border-white/[0.07] border-l-[3px] border-l-orange-300 dark:border-l-orange-400/60"
                  />
                ))}
                <div ref={criticEndRef} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Drawers ── */}
      <LeftDrawer
        open={leftDrawerOpen}
        onClose={() => setLeftDrawerOpen(false)}
        selectedDocs={selectedDocs}
        onToggleDoc={toggleDoc}
      />
      <RightDrawer
        open={rightDrawerOpen}
        onClose={() => setRightDrawerOpen(false)}
        messages={plannerMsgs}
        modelLabel={fullLabel("planner")}
      />

      {/* ── Director's Console ── */}
      <DirectorsConsole
        models={models}
        target={target}
        onTargetChange={handleTargetChange}
        input={input}
        onInputChange={setInput}
        onSend={handleSend}
        isStreaming={driveMode === "auto" && target !== "planner"
          ? !!streaming.proposer || !!streaming.critic
          : !!streaming[target]}
        driveMode={driveMode}
        onDriveModeChange={(mode) => {
          setDriveMode(mode);
          if (mode === "auto" && target === "critic") setTarget("proposer");
        }}
        autoTurns={autoTurns}
        onAutoTurnsChange={setAutoTurns}
      />
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrbitPlusPage() {
  const [phase,  setPhase ] = useState<"config" | "arena">("config");
  const [isDark, setIsDark] = useState(true);

  // ── 入场暗幕：useState 初始化函数同步执行，彻底消灭首帧 race condition ────
  // 两个 state 都在 initializer 里读取 sessionStorage（初始化函数只在首次 render 前调用一次）
  const [fromTransition] = useState<boolean>(() =>
    typeof window !== "undefined" && sessionStorage.getItem("orbitTransition") === "1"
  );
  // entryVeil 首帧即为 true（从 transition 来时），不需要 useEffect 再 setEntryVeil(true)
  const [entryVeil, setEntryVeil] = useState<boolean>(() =>
    typeof window !== "undefined" && sessionStorage.getItem("orbitTransition") === "1"
  );

  useEffect(() => {
    // 清除 flag（在 mount 后执行，确保两个 useState 初始化函数都已读取完毕）
    sessionStorage.removeItem("orbitTransition");
    if (!fromTransition) return;
    // 立即开始渐出遮幕（已挂载，DOM 已就绪）
    requestAnimationFrame(() => requestAnimationFrame(() => setEntryVeil(false)));
    // 还原 body 背景色（page.tsx 导航前将其设为黑色防白屏）
    const t = setTimeout(() => { document.body.style.backgroundColor = ""; }, 900);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [models, setModels] = useState<Record<RoleKey, string>>({
    proposer: "gpt-5.4",
    critic:   "claude-sonnet-4-6",
    planner:  "gemini-3.1-pro-preview",
  });
  const [agentInstructions, setAgentInstructions] = useState<Record<RoleKey, string>>({
    proposer: "",
    critic:   "",
    planner:  "",
  });

  // Sync dark class to <html>
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  // Restore system preference on unmount
  useEffect(() => {
    return () => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", prefersDark);
    };
  }, []);

  const handleModelChange = (role: RoleKey) => (v: string) => {
    setModels((prev) => ({ ...prev, [role]: v }));
  };

  const handleInstructionChange = (role: RoleKey) => (v: string) => {
    setAgentInstructions((prev) => ({ ...prev, [role]: v }));
  };

  const toggleDark = () => setIsDark((v) => !v);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0d0e10] text-gray-900 dark:text-white">
      {/* 入场暗幕：接续主页 Orbit+ 飞入动画，渐现页面 */}
      <AnimatePresence>
        {entryVeil && (
          <motion.div
            key="entry-veil"
            className="fixed inset-0 z-[100] bg-[#0d0e10] pointer-events-none"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.65, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      {/* Ambient glow (dark only) */}
      {isDark && (
        <div className="pointer-events-none fixed inset-0 overflow-hidden">
          <div className="absolute -top-[20%] left-[10%] h-[500px] w-[500px] rounded-full bg-violet-600/10 blur-[120px]" />
          <div className="absolute -bottom-[10%] right-[5%] h-[400px] w-[400px] rounded-full bg-indigo-600/8 blur-[100px]" />
          <div className="absolute top-[40%] left-[60%] h-[300px] w-[300px] rounded-full bg-rose-600/6 blur-[90px]" />
        </div>
      )}

      <AnimatePresence mode="wait">
        {phase === "config" ? (
          <ConfigView
            key="config"
            models={models}
            onModelChange={handleModelChange}
            agentInstructions={agentInstructions}
            onInstructionChange={handleInstructionChange}
            onLaunch={() => { setPhase("arena"); setIsDark(false); }}
            isDark={isDark}
            onToggleDark={toggleDark}
            fromTransition={fromTransition}
          />
        ) : (
          <ArenaView
            key="arena"
            models={models}
            agentInstructions={agentInstructions}
            onBack={() => { setPhase("config"); setIsDark(true); }}
            isDark={isDark}
            onToggleDark={toggleDark}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
