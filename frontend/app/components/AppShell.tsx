"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import SplashScreen from "./SplashScreen";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [splashDone, setSplashDone] = useState(false);
  const [splashFlying, setSplashFlying] = useState(false);
  const [orbitRevealed, setOrbitRevealed] = useState(false);
  const landedRef = useRef(false);

  const handleFly = useCallback(() => setSplashFlying(true), []);

  const handleLanded = useCallback(() => {
    if (landedRef.current) return;
    landedRef.current = true;

    // 先让主页 Orbit 瞬间显示
    const mainOrbit = document.querySelector<HTMLElement>(
      "[data-splash-target='orbit']"
    );
    if (mainOrbit) {
      mainOrbit.style.transition = "none";
      mainOrbit.style.opacity = "1";
    }

    setOrbitRevealed(true);

    // 300ms 容错重叠：splash Orbit 和主页 Orbit 同时可见，视觉一致
    // 之后移除 splash 并恢复 transition
    setTimeout(() => {
      if (mainOrbit) {
        mainOrbit.style.transition = "";
        mainOrbit.style.opacity = "";
      }
      setSplashDone(true);
    }, 300);
  }, []);

  useEffect(() => {
    const state = orbitRevealed ? "done" : splashFlying ? "flying" : "active";
    document.documentElement.setAttribute("data-splash", state);
  }, [orbitRevealed, splashFlying]);

  return (
    <>
      {!splashDone && <SplashScreen onFly={handleFly} onLanded={handleLanded} />}
      <motion.div
        className="min-h-full flex flex-col"
        initial={{ opacity: 0 }}
        animate={{ opacity: splashFlying ? 1 : 0 }}
        transition={{
          duration: 0.8,
          ease: [0.4, 0, 0.2, 1],
        }}
      >
        {children}
      </motion.div>
    </>
  );
}
