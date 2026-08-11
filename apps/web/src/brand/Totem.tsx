/**
 * The totem itself — a brass spinning top.
 *
 * The metaphor is load-bearing rather than decorative: a totem is the one
 * object an adversary who controls everything you can see still cannot forge,
 * which is exactly what the encrypted budget is to the agent.
 *
 * Drawn as stacked shapes — spire, cone, disc — rather than one outline. A
 * single silhouette of a top is a thin vertical spike crossed by a wide
 * horizontal bar, which the eye resolves as a four-pointed star every time. It
 * only reads as a top once the disc is an *ellipse*, because the ellipse is
 * what supplies the viewing angle.
 *
 * What makes the hero version read as metal rather than as a flat icon:
 *
 *   - Banded speculars. Polished metal does not fade smoothly from light to
 *     dark; it inverts repeatedly as the surface curves, so the gradients here
 *     alternate bright and dark rather than ramping once.
 *   - A visible disc underside, darker than the top and offset, which is what
 *     gives the rim thickness.
 *   - Occlusion where the cone meets the disc, and bounce light on the cone's
 *     lower edge picked up from the floor.
 *   - Two shadows: a tight contact shadow at the point and a longer, softer
 *     cast shadow. One alone reads as a sticker.
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
    >
      <defs>
        <linearGradient id="tm-brass" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0%" stopColor="#f0d79a" />
          <stop offset="26%" stopColor="#c9a24a" />
          <stop offset="52%" stopColor="#7e6224" />
          <stop offset="74%" stopColor="#d9b563" />
          <stop offset="100%" stopColor="#6b5220" />
        </linearGradient>
        <linearGradient id="tm-cone" x1="0.2" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#a98736" />
          <stop offset="55%" stopColor="#5d4718" />
          <stop offset="100%" stopColor="#8a6c2a" />
        </linearGradient>
      </defs>
      {/* Spire: a narrow stem, most of the height. */}
      <path
        fill="url(#tm-brass)"
        d="M24 3 C25.6 14 26.4 26 26.6 37 L21.4 37 C21.6 26 22.4 14 24 3 Z"
      />
      {/* Cone: short, concave-sided, ending on the point. */}
      <path fill="url(#tm-cone)" d="M8 41 C12 50 17.5 58 24 62 C30.5 58 36 50 40 41 Z" />
      {/* Disc: the ellipse that supplies the viewing angle. */}
      <ellipse cx="24" cy="39.4" rx="21" ry="5" fill="url(#tm-brass)" />
    </svg>
  );
}

/**
 * Hero treatment. Sized by its container rather than a prop — it is only ever
 * used in one place.
 */
export function TotemHero() {
  return (
    <div className="totem-hero" aria-hidden="true">
      <svg viewBox="0 0 320 310" className="totem-hero-svg">
        <defs>
          {/*
            Disc top. Five bands rather than a smooth ramp: a turned brass
            surface catches the key light, rolls into shadow, catches the fill,
            and rolls again. A single light-to-dark gradient reads as plastic.
          */}
          <linearGradient id="th-disc" x1="0.04" y1="0.1" x2="0.96" y2="0.9">
            <stop offset="0%" stopColor="#7a5f24" />
            <stop offset="12%" stopColor="#e6cd90" />
            <stop offset="27%" stopColor="#fbf0cd" />
            <stop offset="41%" stopColor="#b08f3c" />
            <stop offset="55%" stopColor="#5f4a1b" />
            <stop offset="69%" stopColor="#a5853a" />
            <stop offset="84%" stopColor="#e3c884" />
            <stop offset="100%" stopColor="#6d5420" />
          </linearGradient>

          {/* Underside: same metal, no key light on it. */}
          <linearGradient id="th-under" x1="0" y1="0" x2="1" y2="0.4">
            <stop offset="0%" stopColor="#43340f" />
            <stop offset="45%" stopColor="#221a08" />
            <stop offset="100%" stopColor="#4d3c14" />
          </linearGradient>

          {/* Cone: dark through the body, with floor bounce at the bottom. */}
          <linearGradient id="th-cone" x1="0.15" y1="0" x2="0.92" y2="0.85">
            <stop offset="0%" stopColor="#8e7130" />
            <stop offset="22%" stopColor="#3d2f10" />
            <stop offset="55%" stopColor="#1d1608" />
            <stop offset="80%" stopColor="#2e2410" />
            <stop offset="100%" stopColor="#6b5423" />
          </linearGradient>

          <linearGradient id="th-spire" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#6a5220" />
            <stop offset="22%" stopColor="#f4e3b0" />
            <stop offset="46%" stopColor="#c2a052" />
            <stop offset="63%" stopColor="#5a4519" />
            <stop offset="86%" stopColor="#d8bc72" />
            <stop offset="100%" stopColor="#4d3b13" />
          </linearGradient>

          <radialGradient id="th-contact" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,0,0,0.9)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>

          <radialGradient id="th-cast" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0,0,0,0.5)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>

          <radialGradient id="th-floor" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(201,162,74,0.16)" />
            <stop offset="60%" stopColor="rgba(201,162,74,0.04)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>

          <filter id="th-blur6" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter id="th-blur2" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>

        {/* Floor: a pool of warm light, then the two shadows. */}
        <ellipse cx="160" cy="250" rx="146" ry="46" fill="url(#th-floor)" />
        <ellipse cx="172" cy="252" rx="96" ry="15" fill="url(#th-cast)" filter="url(#th-blur6)" />
        <ellipse cx="160" cy="249" rx="20" ry="5" fill="url(#th-contact)" filter="url(#th-blur2)" />

        {/* The rim, smeared by rotation. Behind the solid form. */}
        <g className="totem-hero-arcs" fill="none" strokeLinecap="round">
          <path d="M78 150 A 82 21 0 0 1 242 150" stroke="rgba(240,215,154,0.45)" strokeWidth="1.4" />
          <path d="M96 166 A 64 16 0 0 0 224 166" stroke="rgba(201,162,74,0.28)" strokeWidth="1.1" />
        </g>

        <g className="totem-hero-body">
          {/* Spire — narrow stem, most of the height. */}
          <path
            fill="url(#th-spire)"
            d="M160 24 C165 60 168 106 169 150 L151 150 C152 106 155 60 160 24 Z"
          />

          {/* Cone — short, concave-sided, ending on the point. */}
          <path
            fill="url(#th-cone)"
            d="M90 160 C106 198 132 226 160 242 C188 226 214 198 230 160 Z"
          />

          {/* Occlusion where the cone tucks under the disc. */}
          <ellipse cx="160" cy="163" rx="70" ry="13" fill="#120d04" opacity="0.75" />

          {/* Disc underside, then the lit top offset above it — the offset is
              the rim's thickness. */}
          <ellipse cx="160" cy="159" rx="76" ry="18.5" fill="url(#th-under)" />
          <ellipse cx="160" cy="154" rx="76" ry="18.5" fill="url(#th-disc)" />

          {/* Specular arc along the far edge of the disc. */}
          <path
            d="M92 149 A 76 18.5 0 0 1 228 149"
            fill="none"
            stroke="rgba(255,248,224,0.65)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          {/* Key highlight on the lit side of the spire. */}
          <path
            d="M158 30 C161 64 164 108 165 148"
            fill="none"
            stroke="rgba(255,250,232,0.9)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {/* Bounce light on the cone's lower left, from the floor. */}
          <path
            d="M112 186 C124 208 140 226 157 238"
            fill="none"
            stroke="rgba(226,196,120,0.32)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
}
