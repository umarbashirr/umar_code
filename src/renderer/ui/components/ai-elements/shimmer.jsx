"use client";;
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { memo, useMemo } from "react";

// Cache motion components at module level to avoid creating during render
const motionComponentCache = new Map();

const getMotionComponent = (element) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2
}) => {
  const MotionComponent = getMotionComponent(Component);

  // The band is sized from the text it sweeps, which leaves a short label like
  // "Grep" or "working" with an 8px sliver: a glint rather than something
  // moving. Below roughly forty pixels the eye reads it as a rendering fault,
  // so that is the floor.
  const dynamicSpread = useMemo(
    () => Math.max(36, (children?.length ?? 0) * spread),
    [children, spread],
  );

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        // The band is the foreground colour, not the background one. Painted in
        // --color-background it is a light gap on the light theme and a dark
        // gap on the dark one, so half the time the sweep reads as a hole
        // travelling through the text instead of light passing over it.
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-foreground),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,

          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))"
        }
      }
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}>
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
