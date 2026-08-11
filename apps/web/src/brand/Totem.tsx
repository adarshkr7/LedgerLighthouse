/**
 * The totem itself — a spinning top.
 *
 * Used as the wordmark glyph on both surfaces, and at hero size on the landing
 * page. The metaphor is load-bearing rather than decorative: a totem is the one
 * object an adversary who controls everything you can see still cannot forge,
 * which is exactly what the encrypted budget is to the agent.
 *
 * Drawn as three stacked shapes — spire, cone, disc — rather than one outline.
 * A single silhouette of a top is a thin vertical spike crossed by a wide
 * horizontal bar, which the eye resolves as a four-pointed star every time. It
 * only reads as a top once the disc is an *ellipse*, because the ellipse is
 * what supplies the viewing angle.
 *
 * `spinning` adds the wobble, driven by CSS in the consuming stylesheet
 * (`.totem[data-spin]`) so it costs nothing and honours prefers-reduced-motion
 * through the global rule in styles.css.
 */

export function TotemMark({
  size = 18,
  spinning = false,
  className,
}: {
  size?: number;
  spinning?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={["totem", className].filter(Boolean).join(" ")}
      {...(spinning ? { "data-spin": "" } : {})}
      viewBox="0 0 48 64"
      width={size}
      height={(size * 64) / 48}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      {/* Spire: a narrow stem, most of the height. */}
      <path d="M24 3 C25.6 14 26.4 26 26.6 37 L21.4 37 C21.6 26 22.4 14 24 3 Z" />
      {/* Cone: short, concave-sided, ending on the point. */}
      <path d="M7 40 C11 50 17 58 24 62 C31 58 37 50 41 40 Z" opacity="0.75" />
      {/* Disc: the ellipse that supplies the viewing angle. */}
      <ellipse cx="24" cy="39.5" rx="21" ry="5.2" />
    </svg>
  );
}

/**
 * Hero treatment: the same three shapes, given a lit floor, a contact shadow
 * and a smeared rim arc. Sized by its container rather than a prop — it is only
 * ever used in one place.
 */
export function TotemHero() {
  return (
    <div className="totem-hero" aria-hidden="true">
      <svg viewBox="0 0 320 300" className="totem-hero-svg">
        <defs>
          <radialGradient id="th-pool" cx="50%" cy="80%" r="58%">
            <stop offset="0%" stopColor="rgba(79,227,193,0.22)" />
            <stop offset="55%" stopColor="rgba(79,227,193,0.05)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
          {/* Disc top: lit from the upper left, falling into shadow at the rim. */}
          <linearGradient id="th-disc" x1="0.05" y1="0" x2="0.95" y2="1">
            <stop offset="0%" stopColor="#f2f7ff" />
            <stop offset="30%" stopColor="#9fb4cf" />
            <stop offset="70%" stopColor="#3a4658" />
            <stop offset="100%" stopColor="#1b222e" />
          </linearGradient>
          <linearGradient id="th-cone" x1="0.15" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#2a3444" />
            <stop offset="55%" stopColor="#121821" />
            <stop offset="100%" stopColor="#080b11" />
          </linearGradient>
          <linearGradient id="th-spire" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#e8f0fa" />
            <stop offset="55%" stopColor="#7f93ad" />
            <stop offset="100%" stopColor="#2b3546" />
          </linearGradient>
          <radialGradient id="th-shadow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,0,0,0.8)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
          <filter id="th-soft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* Floor light, and the shadow the top casts into it. */}
        <ellipse cx="160" cy="244" rx="150" ry="52" fill="url(#th-pool)" />
        <ellipse cx="160" cy="243" rx="70" ry="12" fill="url(#th-shadow)" />
        <ellipse cx="160" cy="243" rx="16" ry="4" fill="#000" opacity="0.65" filter="url(#th-soft)" />

        {/* Rim arcs: the spin, smeared. Behind the solid form. */}
        <g className="totem-hero-arcs" fill="none" strokeLinecap="round">
          <path d="M74 158 A 86 22 0 0 1 246 158" stroke="rgba(79,227,193,0.5)" strokeWidth="1.6" />
          <path d="M92 172 A 68 17 0 0 0 228 172" stroke="rgba(167,139,250,0.32)" strokeWidth="1.2" />
        </g>

        <g className="totem-hero-body">
          {/* Spire — narrow stem, most of the height. */}
          <path
            fill="url(#th-spire)"
            d="M160 26 C165 62 168 106 169 150 L151 150 C152 106 155 62 160 26 Z"
          />
          {/* Cone — short, concave-sided, ending on the point. */}
          <path
            fill="url(#th-cone)"
            d="M88 158 C104 194 130 220 160 234 C190 220 216 194 232 158 Z"
          />
          {/* Disc — the ellipse that makes it a top rather than a star. */}
          <ellipse cx="160" cy="155" rx="76" ry="19" fill="url(#th-disc)" />
          <ellipse
            cx="160"
            cy="155"
            rx="76"
            ry="19"
            fill="none"
            stroke="rgba(226,238,252,0.5)"
            strokeWidth="1"
          />
          {/* Specular highlight along the lit edge of the spire. */}
          <path
            d="M160 32 C163 66 166 108 167 148"
            fill="none"
            stroke="rgba(240,247,255,0.9)"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
}
