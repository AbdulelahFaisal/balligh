import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "bl-btn btn-tactile whitespace-nowrap no-underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        default: "bl-btn--primary",
        outline: "bl-btn--secondary shadow-soft",
        ghost: "bg-transparent text-primary hover:bg-muted",
        accent:
          "bg-accent text-accent-foreground shadow-[0_1px_0_oklch(1_0_0/0.15)_inset,0_10px_22px_-12px_oklch(0.45_0.12_40/0.75)] hover:bg-[oklch(0.46_0.13_40)]",
      },
      size: { default: "", sm: "min-h-9 px-3 py-1.5 text-sm", lg: "bl-btn--lg" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
