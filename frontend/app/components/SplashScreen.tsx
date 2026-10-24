"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";

function useWaveCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>, active: boolean) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf: number;
    let t = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const waves = [
      { amp: 30, freq: 0.005, speed: 0.010, yRatio: 0.25, color: "rgba(191,219,254,0.22)" },
      { amp: 24, freq: 0.008, speed: 0.007, yRatio: 0.40, color: "rgba(147,197,253,0.16)" },
      { amp: 36, freq: 0.004, speed: 0.013, yRatio: 0.55, color: "rgba(219,234,254,0.18)" },
      { amp: 20, freq: 0.010, speed: 0.009, yRatio: 0.70, color: "rgba(96,165,250,0.10)" },
      { amp: 28, freq: 0.006, speed: 0.016, yRatio: 0.15, color: "rgba(219,234,254,0.20)" },
    ];

    const draw = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);

      for (const wave of waves) {
        ctx.beginPath();
        const baseY = h * wave.yRatio;
        for (let x = 0; x <= w; x += 2) {
          const y =
            baseY +
            Math.sin(x * wave.freq + t * wave.speed) * wave.amp +
            Math.sin(x * wave.freq * 1.7 + t * wave.speed * 0.6 + 1.5) * wave.amp * 0.45;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = wave.color;
        ctx.fill();
      }

      t += 1;
      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef, active]);
}

type Phase = "intro" | "hold" | "fly" | "landed";

interface SplashScreenProps {
  onFly: () => void;
  onLanded: () => void;
}

export default function SplashScreen({ onFly, onLanded }: SplashScreenProps) {
  const [phase, setPhase] = useState<Phase>("intro");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbitRef = useRef<HTMLSpanElement>(null);
  const stableOnFly = useCallback(onFly, [onFly]);
  const stableOnLanded = useCallback(onLanded, [onLanded]);

  useWaveCanvas(canvasRef, phase !== "landed");

  const mvX = useMotionValue(0);
  const mvY = useMotionValue(0);
  const mvScale = useMotionValue(0.9); // 从 0.9 开始，intro 时动画到 1
  const mvBgOpacity = useMotionValue(1);
  const bgOpacity = useTransform(mvBgOpacity, v => v);

  // intro 入场：scale 0.9 → 1
  useEffect(() => {
    animate(mvScale, 1, { duration: 0.6, ease: [0.16, 1, 0.3, 1] });
  }, [mvScale]);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("hold"), 800);

    const t2 = setTimeout(() => {
      stableOnFly();

      // 等两帧让主页 DOM 布局完成
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const splashRect = orbitRef.current?.getBoundingClientRect();
          const mainOrbit = document.querySelector<HTMLElement>(
            "[data-splash-target='orbit']"
          );
          const targetRect = mainOrbit?.getBoundingClientRect();

          if (!splashRect || !targetRect || !mainOrbit) {
            setPhase("landed");
            stableOnLanded();
            return;
          }

          // 用 computed font-size 精确计算缩放比
          const splashFontSize = parseFloat(
            getComputedStyle(orbitRef.current!).fontSize
          );
          const targetFontSize = parseFloat(
            getComputedStyle(mainOrbit).fontSize
          );
          const scaleRatio = targetFontSize / splashFontSize;

          // 用缩放后的中心点对齐（scale 从中心缩放，需要补偿位移）
          const srcCX = splashRect.left + splashRect.width / 2;
          const srcCY = splashRect.top + splashRect.height / 2;
          const dstCX = targetRect.left + targetRect.width / 2;
          const dstCY = targetRect.top + targetRect.height / 2;

          setPhase("fly");

          const flyDuration = 0.9;
          const easing = [0.4, 0, 0.15, 1] as [number, number, number, number];

          // 同时启动所有动画
          animate(mvX, dstCX - srcCX, { duration: flyDuration, ease: easing });
          animate(mvY, dstCY - srcCY, { duration: flyDuration, ease: easing });
          animate(mvScale, scaleRatio, { duration: flyDuration, ease: easing });
          animate(mvBgOpacity, 0, { duration: flyDuration * 0.6, ease: easing });

          // 飞行结束后 → 精确回调
          setTimeout(() => {
            setPhase("landed");
            stableOnLanded();
          }, flyDuration * 1000 + 16);
        });
      });
    }, 2800);

    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [stableOnFly, stableOnLanded, mvX, mvY, mvScale, mvBgOpacity]);

  // landed：背景已消失，只剩 Orbit 停在目标位置
  // 不 return null —— 由父组件 AppShell 控制何时移除整个 SplashScreen

  const gradientKeyframes = [
    "linear-gradient(135deg, #3b82f6, #8b5cf6, #06b6d4)",
    "linear-gradient(135deg, #6366f1, #3b82f6, #a78bfa)",
    "linear-gradient(135deg, #06b6d4, #6366f1, #3b82f6)",
    "linear-gradient(135deg, #3b82f6, #8b5cf6, #06b6d4)",
  ];

  return (
    <div
      className="fixed inset-0 z-[9999] overflow-hidden select-none"
      style={{ pointerEvents: phase === "fly" ? "none" : "auto" }}
    >
      {/* 开机背景 */}
      <motion.div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(135deg, #ffffff 0%, #eff6ff 30%, #dbeafe 55%, #bfdbfe 100%)",
          opacity: bgOpacity,
        }}
      />

      {/* Canvas 浪花 */}
      <motion.canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ opacity: bgOpacity }}
      />

      {/* 中央 Orbit 文字 */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <motion.span
          ref={orbitRef}
          className="relative z-10 font-bold select-none"
          style={{
            fontSize: "clamp(56px, 8vw, 80px)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            x: mvX,
            y: mvY,
            scale: mvScale,
          }}
          initial={{ opacity: 0 }}
          animate={
            phase === "intro" || phase === "hold"
              ? {
                  opacity: 1,
                  backgroundImage: gradientKeyframes,
                  filter:
                    "drop-shadow(0 0 20px rgba(96,165,250,0.35)) drop-shadow(0 2px 8px rgba(99,102,241,0.15))",
                }
              : {
                  opacity: 1,
                  backgroundImage: "linear-gradient(to right, #3b82f6, #a855f7)",
                  filter: "drop-shadow(0 0 0px transparent)",
                }
          }
          transition={
            phase === "intro" || phase === "hold"
              ? {
                  opacity: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
                  backgroundImage: { duration: 6, repeat: Infinity, ease: "linear" },
                  filter: { duration: 0.6 },
                }
              : {
                  backgroundImage: { duration: 0.5 },
                  filter: { duration: 0.5 },
                }
          }
        >
          Orbit
        </motion.span>
      </div>

      {/* 底部标语 */}
      <motion.p
        className="absolute bottom-12 left-0 right-0 text-center text-sm text-blue-300/50 tracking-widest font-light"
        initial={{ opacity: 0 }}
        animate={{ opacity: phase === "hold" ? 1 : 0 }}
        transition={{ duration: 0.4 }}
      >
        Research Agent
      </motion.p>
    </div>
  );
}
