/**
 * Monochrome line icons for the landing page.
 *
 * Inline SVG rather than an icon package: the brief rules out new dependencies,
 * and thirteen 20px glyphs are not worth a runtime. Every icon is a 1px stroke
 * on `currentColor`, so colour is decided entirely by CSS and the set stays
 * uniform — no fills, no two-tone, nothing that would read as decoration.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Glyph({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const WalletIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v1.5" />
    <rect x="3" y="7.5" width="18" height="11.5" rx="2" />
    <path d="M16 13.25h1.5" />
  </Glyph>
);

export const LockIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4.5" y="10.5" width="15" height="9" rx="2" />
    <path d="M8 10.5V7.75a4 4 0 0 1 8 0v2.75" />
  </Glyph>
);

export const AgentIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
    <path d="M10 3.5v2.5M14 3.5v2.5M10 18v2.5M14 18v2.5M3.5 10H6M3.5 14H6M18 10h2.5M18 14h2.5" />
  </Glyph>
);

export const ShieldIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 3.5 5.5 6v6c0 4 2.75 7 6.5 8.5 3.75-1.5 6.5-4.5 6.5-8.5V6Z" />
  </Glyph>
);

export const RecordIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M6 3.5h8.5L18.5 7.5V20.5H6Z" />
    <path d="M14 3.5v4.25h4.25M9 12h6M9 15.5h6" />
  </Glyph>
);

export const KeyIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="8" cy="12" r="3.5" />
    <path d="M11.5 12H20.5M17.5 12v3M14.5 12v2.25" />
  </Glyph>
);

export const SettleIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 9h13.5M14 5.5 17.5 9 14 12.5" />
    <path d="M20 15H6.5M10 11.5 6.5 15 10 18.5" />
  </Glyph>
);

export const SplitIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 3.5v17" strokeDasharray="2 2.5" />
    <path d="M8.25 8.25 4.5 12l3.75 3.75M15.75 8.25 19.5 12l-3.75 3.75" />
  </Glyph>
);

export const ReplayIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4.5V9h-4.5" />
    <path d="m9.5 14.5 5-5" />
  </Glyph>
);

export const ClockIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M12 7.25V12l3 1.75" />
  </Glyph>
);

export const CapIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 16.5a8 8 0 0 1 16 0" />
    <path d="M12 16.5 15.5 10" />
    <path d="M4 19.5h16" />
  </Glyph>
);

export const VerifyIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M10.5 12.75 12 14.5l3.5-4" />
    <path d="M12 3.5 5.5 6v6c0 4 2.75 7 6.5 8.5 3.75-1.5 6.5-4.5 6.5-8.5V6Z" />
  </Glyph>
);

export const ArrowIcon = (p: IconProps) => (
  <Glyph {...p} width="16" height="16">
    <path d="M5 12h13M13.5 7.5 18 12l-4.5 4.5" />
  </Glyph>
);
