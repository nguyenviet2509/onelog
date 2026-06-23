import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Tailwind-aware classname merger — handles conditional + conflict resolution.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
