"use client";
import { Tooltip as RT } from "radix-ui";

export function Tip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RT.Provider delayDuration={300}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content side={side} sideOffset={6} className="z-[70] max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-[12px] leading-snug text-white shadow-pop">
            {content}
            <RT.Arrow className="fill-ink" />
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
