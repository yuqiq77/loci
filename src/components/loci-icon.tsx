import { useId } from "react";

export function LociIcon({
  className,
  filled = false,
}: {
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {filled ? (
        <path
          d="M12 4l8 6.5v10h-5.2v-3a2.8 2.8 0 0 0-5.6 0v3H4v-10Z"
          fill="currentColor"
        />
      ) : (
        <>
          <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z" />
          <path d="M10 20.5v-3a2 2 0 0 1 4 0v3" />
        </>
      )}
    </svg>
  );
}

// The same house as liquid glass for the empty-chat mark. On a light page
// white highlights alone vanish, so the body carries a faint smoky tint. A
// lighting filter bevels the edges: a dark refraction band inside the rim,
// a bright key light from the top-left, a softer fill light from the
// bottom-right, and a light shade on the lower inner edge. A radial sheen
// glosses the upper left.
const GLASS_HOUSE =
  "M20.2 9.25Q24 6 27.8 9.25L38.34 18.23Q41 20.5 41 24V36Q41 41 36 41H30Q28.5 41 28.5 39.5V34.5A4.5 4.5 0 0 0 19.5 34.5V39.5Q19.5 41 18 41H12Q7 41 7 36V24Q7 20.5 9.66 18.23Z";

export function GlassLociIcon({ className }: { className?: string }) {
  const id = useId().replace(/[^\w-]/g, "");

  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 48 48">
      <defs>
        <linearGradient id={`${id}-body`} x1="0.3" x2="0.7" y1="0" y2="1">
          <stop offset="0" stopColor="#24211d" stopOpacity="0.06" />
          <stop offset="0.6" stopColor="#24211d" stopOpacity="0.14" />
          <stop offset="1" stopColor="#24211d" stopOpacity="0.22" />
        </linearGradient>
        <radialGradient id={`${id}-sheen`} cx="0.32" cy="0.18" r="0.62">
          <stop offset="0" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <filter
          colorInterpolationFilters="sRGB"
          height="140%"
          id={`${id}-glass`}
          width="140%"
          x="-20%"
          y="-20%"
        >
          <feGaussianBlur in="SourceAlpha" result="bump" stdDeviation="3.2" />
          <feComposite
            in="SourceAlpha"
            in2="bump"
            k2="1"
            k3="-1"
            operator="arithmetic"
            result="band"
          />
          <feFlood floodColor="#24211d" floodOpacity="0.55" />
          <feComposite in2="band" operator="in" result="bandFill" />
          <feOffset dx="-1.2" dy="-1.6" in="bump" result="raised" />
          <feComposite in="SourceAlpha" in2="raised" operator="out" result="lower" />
          <feFlood floodColor="#24211d" floodOpacity="0.12" />
          <feComposite in2="lower" operator="in" result="shade" />
          <feSpecularLighting
            in="bump"
            lightingColor="#fff"
            result="key"
            specularConstant="2"
            specularExponent="45"
            surfaceScale="8"
          >
            <feDistantLight azimuth="235" elevation="45" />
          </feSpecularLighting>
          <feComposite in="key" in2="SourceAlpha" operator="in" result="keyIn" />
          <feSpecularLighting
            in="bump"
            lightingColor="#fff"
            result="fill"
            specularConstant="1.3"
            specularExponent="35"
            surfaceScale="8"
          >
            <feDistantLight azimuth="55" elevation="35" />
          </feSpecularLighting>
          <feComposite in="fill" in2="SourceAlpha" operator="in" result="fillIn" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="bandFill" />
            <feMergeNode in="shade" />
            <feMergeNode in="fillIn" />
            <feMergeNode in="keyIn" />
          </feMerge>
        </filter>
      </defs>
      <path d={GLASS_HOUSE} stroke="#24211d" strokeOpacity="0.06" />
      <path
        d={GLASS_HOUSE}
        fill={`url(#${id}-body)`}
        filter={`url(#${id}-glass)`}
      />
      <path d={GLASS_HOUSE} fill={`url(#${id}-sheen)`} />
    </svg>
  );
}
