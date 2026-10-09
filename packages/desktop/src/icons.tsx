// Íconos inline (estilo trazo de 1.6px) para no depender de una librería.
import type { ReactNode, SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronDown = () => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const ChevronsUpDown = () => (
  <Icon>
    <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
  </Icon>
);
export const Check = () => (
  <Icon>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);
export const Plus = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const Search = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const Sliders = () => (
  <Icon>
    <path d="M4 6h10M18 6h2M4 18h4M12 18h8M14 4v4M8 16v4M4 12h16" />
  </Icon>
);
export const UserPlus = () => (
  <Icon>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" />
  </Icon>
);
export const LayoutGrid = () => (
  <Icon>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);
export const LayoutColumns = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M9.3 4v16M14.7 4v16" />
  </Icon>
);
export const LayoutSingle = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
  </Icon>
);
export const Minus = () => (
  <Icon>
    <path d="M6 12h12" />
  </Icon>
);
export const Maximize = () => (
  <Icon>
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </Icon>
);
export const Close = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const Logo = () => (
  <Icon strokeWidth="2">
    <circle cx="9" cy="12" r="4" />
    <circle cx="15" cy="12" r="4" />
  </Icon>
);
export const SignOut = () => (
  <Icon>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </Icon>
);
