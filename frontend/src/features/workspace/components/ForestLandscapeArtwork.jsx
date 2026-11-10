import { useId } from 'react'

export default function ForestLandscapeArtwork({ variant = 'header' }) {
  const instanceId = useId().replace(/:/g, '')
  const fadeId = `roadmap-landscape-fade-${instanceId}`
  const maskId = `roadmap-landscape-mask-${instanceId}`
  const pineId = `roadmap-landscape-pine-${instanceId}`

  return (
    <svg
      className={`roadmap-landscape roadmap-landscape--${variant}`}
      viewBox="0 0 800 180"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={fadeId}>
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset=".32" stopColor="white" stopOpacity=".08" />
          <stop offset=".72" stopColor="white" />
        </linearGradient>
        <mask id={maskId}>
          <rect width="800" height="180" fill={`url(#${fadeId})`} />
        </mask>
        <path
          id={pineId}
          d="M0 0 8 20 5 19 12 34 8 32 16 48 3 46 3 54H-3v-8l-13 2 8-16-4 2 7-15-3 1Z"
        />
      </defs>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#c6ddca"
          opacity=".7"
          d="M0 157Q97 143 172 111T264 112Q318 97 379 67T457 76Q520 63 590 33T665 37Q732 53 800 18v162H0Z"
        />
        <path
          fill="#91bc9e"
          opacity=".5"
          d="M0 165Q105 159 188 131T280 138Q363 126 425 99T519 107Q584 97 650 67T725 68Q766 72 800 57v123H0Z"
        />
        <path
          fill="#689c77"
          opacity=".43"
          d="M0 180Q146 177 248 151T366 153Q425 149 492 126T585 125Q639 120 705 97T800 94v86Z"
        />
        <g fill="#518965" opacity=".55">
          <use
            href={`#${pineId}`}
            transform="translate(498 133) scale(.53)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(518 119) scale(.78)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(560 123) scale(.74)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(605 110) scale(.88)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(645 95) scale(1.02)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(707 78) scale(1.28)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(767 62) scale(1.5)"
          />
        </g>
        <g fill="#356f4e" opacity=".75">
          <use
            href={`#${pineId}`}
            transform="translate(543 135) scale(.74)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(583 123) scale(.96)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(626 117) scale(1.1)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(675 94) scale(1.47)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(731 79) scale(1.71)"
          />
          <use
            href={`#${pineId}`}
            transform="translate(784 54) scale(2.08)"
          />
        </g>
      </g>
    </svg>
  )
}
