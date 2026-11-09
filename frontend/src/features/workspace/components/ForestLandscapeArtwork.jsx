export default function ForestLandscapeArtwork() {
  return (
    <svg className="roadmap-landscape" viewBox="0 0 800 180" preserveAspectRatio="xMaxYMax slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="roadmap-landscape-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#f6f8f4" stopOpacity="0" />
          <stop offset=".45" stopColor="#b8d3be" stopOpacity=".35" />
          <stop offset="1" stopColor="#90b99b" stopOpacity=".45" />
        </linearGradient>
      </defs>
      <path fill="url(#roadmap-landscape-fade)" d="M0 155 100 112 180 132 285 80 355 112 470 53 550 85 660 32 800 77v103H0z" />
      <path fill="#aacbb1" opacity=".35" d="m130 160 120-48 80 20 100-40 75 22 120-51 85 34 90-20v103H130z" />
      <path fill="#739f7c" opacity=".28" d="m330 170 92-38 65 12 94-42 58 24 95-48 66 28v74H330z" />
      <g fill="#356f4e" opacity=".43">
        <path d="m645 158 16-53 16 53h-8v22h-16v-22z" />
        <path d="m686 157 22-77 22 77h-11v23h-22v-23z" />
        <path d="m731 159 25-96 25 96h-13v21h-24v-21z" />
        <path d="m774 159 18-65 18 65h-9v21h-18v-21z" />
      </g>
    </svg>
  )
}
