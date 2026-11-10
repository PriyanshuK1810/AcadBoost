import { useState } from 'react'
import BrandWordmark from '../../app/BrandWordmark'
import { PRODUCT_BRAND } from '../../app/brand'
import ForestLandscapeArtwork from '../../features/workspace/components/ForestLandscapeArtwork'
import './MarketingPage.css'
const pathwaySteps = [
  {
    number: '01',
    title: 'Build skills',
    description: 'Follow structured learning shaped around real-world demands.',
    detail:
      'Build a foundation through a structured path of phases, weeks, and topics.',
    icon: '✳',
  },
  {
    number: '02',
    title: 'Gain experience',
    description:
      'Put learning into practice through projects and industry exposure.',
    detail:
      'Apply what you learn through practice and projects that build experience.',
    icon: '◇',
  },
  {
    number: '03',
    title: 'Be career ready',
    description:
      'Move forward with the confidence to take the next opportunity.',
    detail:
      'Connect your skills and experience to the opportunities you want to pursue.',
    icon: '↗',
  },
]
const learningCycle = [
  {
    number: '01',
    title: 'Plan with a roadmap',
    description:
      'Organize learning into clear phases, weeks, and topics that make sense for each cohort.',
    detail:
      'A shared roadmap makes the sequence of learning easier to understand and discuss.',
    icon: '⌁',
  },
  {
    number: '02',
    title: 'Guide each cohort',
    description:
      'Give students a consistent path while coordinators keep the learning journey in view.',
    detail:
      'A common learning path helps a cohort see what to focus on together.',
    icon: '◇',
  },
  {
    number: '03',
    title: 'Understand progress',
    description:
      'See how learners are moving forward and use those insights to improve what comes next.',
    detail:
      'A clearer view of progress helps teams consider where learners need support.',
    icon: '↗',
  },
]
const roadmapWeeks = [
  {
    week: '01',
    title: 'Find your direction',
    goal: 'Set goals and explore roles',
    detail:
      'Start by considering your interests and the roles you want to explore.',
  },
  {
    week: '02',
    title: 'Build your portfolio',
    goal: 'Turn practice into a project',
    detail: 'Bring your practice together in a project you can share.',
  },
  {
    week: '03',
    title: 'Prepare to connect',
    goal: 'Practice interviews and share your work',
    detail:
      'Prepare to talk about your work and the skills you have developed.',
  },
]
const audiences = [
  {
    title: 'For Training & Placement teams',
    description:
      'Bring curriculum planning and cohort support together around a shared view of student readiness.',
    detail:
      'Organize the learning journey and give each cohort a consistent path.',
    benefits: [
      'Plan and publish structured roadmaps',
      'Organize learners into cohorts',
      'View cohort learning progress',
    ],
    icon: '◇',
  },
  {
    title: 'For students',
    description:
      'Understand what to learn, how it connects to real opportunities, and where to focus next.',
    detail:
      'See the next step in a learning path and connect practice to your goals.',
    benefits: [
      'Follow your assigned roadmap',
      'Explore learning topics and resources',
      'Track your own learning progress',
    ],
    icon: '✳',
  },
]
function LearningCycleCarousel() {
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState(null)
  const last = learningCycle.length - 1

  function select(index) {
    if (index < 0 || index > last || index === active) return
    setActive(index)
    setExpanded(null)
  }

  return (
    <div
      className="cycle-carousel"
      role="group"
      aria-label="Learning-cycle cards"
    >
      <div className="cycle-toolbar">
        <p className="cycle-position" role="status">
          {active + 1} of {learningCycle.length} · {learningCycle[active].title}
        </p>
        <div
          className="cycle-navigation"
          role="group"
          aria-label="Choose a learning-cycle card"
        >
          <button
            type="button"
            className="cycle-nav-button"
            aria-label="Previous learning-cycle card"
            aria-disabled={active === 0}
            onClick={() => select(active - 1)}
          >
            <span aria-hidden="true">←</span>
          </button>
          {learningCycle.map((step, index) => (
            <button
              key={step.number}
              type="button"
              className="cycle-nav-button cycle-index"
              aria-label={`Select ${step.title}`}
              aria-pressed={active === index}
              onClick={() => select(index)}
            >
              {step.number}
            </button>
          ))}
          <button
            type="button"
            className="cycle-nav-button"
            aria-label="Next learning-cycle card"
            aria-disabled={active === last}
            onClick={() => select(active + 1)}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
      <div className="cycle-window">
        <ol className="cycle-list" style={{ '--cycle-index': active }}>
          {learningCycle.map((step, index) => {
            const isExpanded = expanded === index
            return (
              <li
                className={`cycle-item${active === index ? ' is-active' : ''}`}
                key={step.number}
                aria-current={active === index ? 'step' : undefined}
              >
                <article className="cycle-card">
                  <div className="cycle-card-top">
                    <span className="cycle-number" aria-hidden="true">
                      {step.icon}
                    </span>
                    <span className="cycle-card-label">Step {step.number}</span>
                    {active === index && (
                      <span className="cycle-current">Selected</span>
                    )}
                  </div>
                  <h3>{step.title}</h3>
                  <p className="cycle-preview">{step.description}</p>
                  <button
                    className="cycle-toggle"
                    type="button"
                    aria-label={`${isExpanded ? 'Show less about' : 'Learn more about'} ${step.title}`}
                    aria-expanded={isExpanded}
                    aria-controls={`cycle-detail-${step.number}`}
                    onClick={() => {
                      setActive(index)
                      setExpanded(isExpanded ? null : index)
                    }}
                  >
                    {isExpanded ? 'Show less' : 'Learn more'}{' '}
                    <span aria-hidden="true">{isExpanded ? '−' : '+'}</span>
                  </button>
                  <p
                    id={`cycle-detail-${step.number}`}
                    className="cycle-detail"
                    hidden={!isExpanded}
                  >
                    {step.detail}
                  </p>
                </article>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

function AudienceFlipCard({ item, index, flipped, onFlip }) {
  const detailsId = `audience-detail-${index}`
  return (
    <article
      className={`audience-card${flipped ? ' is-flipped' : ''}`}
      aria-label={item.title}
    >
      <div className="audience-perspective">
        <div className="audience-rotor">
          <div className="audience-face" inert={flipped} aria-hidden={flipped}>
            <span className="audience-icon" aria-hidden="true">
              {item.icon}
            </span>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </div>
          <div
            className="audience-face audience-face-back"
            id={detailsId}
            inert={!flipped}
            aria-hidden={!flipped}
          >
            <span className="audience-icon" aria-hidden="true">
              {item.icon}
            </span>
            <h3>How {PRODUCT_BRAND} helps</h3>
            <p>{item.detail}</p>
            <ul className="audience-benefits">
              {item.benefits.map((benefit) => (
                <li key={benefit}>{benefit}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="audience-toggle"
        aria-label={`${flipped ? 'Flip back ·' : 'Explore'} ${item.title}`}
        aria-expanded={flipped}
        aria-controls={detailsId}
        onClick={onFlip}
      >
        {flipped ? 'Flip back' : 'Explore'}{' '}
        <span aria-hidden="true">{flipped ? '↶' : '↻'}</span>
      </button>
    </article>
  )
}

function MarketingPage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [pathway, setPathway] = useState(0)
  const [audience, setAudience] = useState(null)
  const [week, setWeek] = useState(0)
  function closeMenu() {
    setMenuOpen(false)
  }
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header
        className="site-header"
        id="home"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) {
            closeMenu()
            event.currentTarget.querySelector('.menu-toggle')?.focus()
          }
        }}
      >
        <div className="page-container header-inner">
          <BrandWordmark
            className="wordmark"
            href="#home"
            onClick={closeMenu}
          />
          <button
            className="menu-toggle"
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
            aria-controls="site-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
          </button>
          <nav
            className={`site-nav${menuOpen ? ' is-open' : ''}`}
            id="site-navigation"
            aria-label="Main navigation"
          >
            <a href="#for-colleges" onClick={closeMenu}>
              For colleges
            </a>
            <a href="#pathway" onClick={closeMenu}>
              The pathway
            </a>
            <a href="#approach" onClick={closeMenu}>
              How it works
            </a>
            <a href="/review" onClick={closeMenu}>
              Review demo
            </a>
            <a href="/login" onClick={closeMenu}>
              Sign in
            </a>
            <a className="nav-cta" href="/register" onClick={closeMenu}>
              Get started <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="hero-section" aria-labelledby="hero-title">
          <div className="hero-atmosphere" aria-hidden="true">
            <ForestLandscapeArtwork variant="homepage-atmosphere" />
            <svg
              className="hero-atmosphere-path"
              viewBox="0 0 1000 240"
              preserveAspectRatio="none"
              focusable="false"
            >
              <path d="M180 240 C270 187 455 225 496 171 S645 139 686 94 S818 68 940 38" />
            </svg>
          </div>
          <div className="page-container hero-layout">
            <div className="hero-copy">
              <p className="eyebrow">Learning today, brighter tomorrows</p>
              <h1 id="hero-title">
                A guided path from learning to career readiness for every{' '}
                <span>student.</span>
              </h1>
              <p className="hero-description">
                {PRODUCT_BRAND} helps college Training &amp; Placement teams
                bring learning, practice, and progress into one clear journey
                for every student.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="/register">
                  Get started <span aria-hidden="true">→</span>
                </a>
                <a className="text-link" href="/review">
                  View demo <span aria-hidden="true">↗</span>
                </a>
              </div>
              <p className="hero-caption">
                A clearer view of what students learn, practice, and work
                toward.
              </p>
            </div>

            <aside
              className="manifesto-panel example-roadmap"
              aria-label="Example roadmap"
            >
              <div className="hero-forest" aria-hidden="true">
                <ForestLandscapeArtwork variant="homepage" />
                <svg
                  className="hero-path"
                  viewBox="0 0 500 120"
                  preserveAspectRatio="none"
                  focusable="false"
                >
                  <path d="M130 120 C185 78 320 108 295 70 S350 30 460 10" />
                </svg>
              </div>
              <p className="eyebrow">Illustrative roadmap</p>
              <h2>Career readiness</h2>
              <p className="manifesto-description">
                A clear outline for the next three weeks.
              </p>
              <ol>
                {roadmapWeeks.map((item, index) => (
                  <li key={item.week}>
                    <button
                      className="roadmap-week"
                      type="button"
                      aria-pressed={week === index}
                      aria-controls="roadmap-week-goal"
                      onClick={() => setWeek(index)}
                    >
                      <span className="roadmap-marker" aria-hidden="true">
                        {week === index ? '●' : '○'}
                      </span>
                      <span>
                        <small>Week {item.week}</small>
                        <strong>{item.title}</strong>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              <div
                id="roadmap-week-goal"
                className="roadmap-goal"
                aria-live="polite"
                aria-atomic="true"
              >
                <div className="roadmap-detail" key={roadmapWeeks[week].week}>
                  <strong>Week {roadmapWeeks[week].week} goal</strong>
                  <p>
                    {roadmapWeeks[week].goal}. {roadmapWeeks[week].detail}
                  </p>
                </div>
              </div>
              <p className="manifesto-footer">
                Example content · your team creates the learning path.
              </p>
            </aside>
          </div>
        </section>

        <section
          className="pathway-section"
          id="pathway"
          aria-labelledby="pathway-title"
        >
          <div className="page-container">
            <div className="section-heading section-heading-centered">
              <p className="eyebrow eyebrow-light">
                The {PRODUCT_BRAND} pathway
              </p>
              <h2 id="pathway-title">
                Build skills. Gain experience. Be career ready.
              </h2>
              <p>
                A connected learning journey gives students a clearer way
                forward and helps colleges support progress at every stage.
              </p>
            </div>
            <ol
              className="pathway-steps"
              style={{ '--pathway-index': pathway }}
            >
              {pathwaySteps.map((step, index) => (
                <li className="pathway-step" key={step.number}>
                  <article
                    className={`pathway-card${pathway === index ? ' is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="pathway-control"
                      aria-pressed={pathway === index}
                      onClick={() => setPathway(index)}
                    >
                      <span className="step-number" aria-hidden="true">
                        {step.icon}
                      </span>
                      <span className="pathway-label">
                        <small>Stage {step.number}</small>
                        <strong>{step.title}</strong>
                      </span>
                      <span className="selection-label" aria-hidden="true">
                        {pathway === index ? 'Selected' : 'Explore'}
                      </span>
                    </button>
                    {pathway === index && (
                      <div className="pathway-detail">
                        <p>{step.description}</p>
                        <p>{step.detail}</p>
                      </div>
                    )}
                  </article>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          className="cycle-section"
          id="approach"
          aria-labelledby="cycle-title"
        >
          <div className="page-container cycle-layout">
            <div className="section-heading cycle-intro">
              <p className="eyebrow">A more connected approach</p>
              <h2 id="cycle-title">Built around the whole learning cycle.</h2>
              <p>
                {PRODUCT_BRAND} is designed to help Training &amp; Placement
                teams plan a learning journey, guide cohorts through it, and
                understand what students need next.
              </p>
            </div>
            <LearningCycleCarousel />
          </div>
        </section>

        <section
          className="audience-section"
          id="for-colleges"
          aria-labelledby="audience-title"
        >
          <div className="page-container audience-layout">
            <div className="audience-heading">
              <p className="eyebrow">For the people behind student progress</p>
              <h2 id="audience-title">
                One shared purpose. A clearer journey for everyone.
              </h2>
            </div>
            <div className="audience-copy">
              {audiences.map((item, index) => (
                <AudienceFlipCard
                  key={item.title}
                  item={item}
                  index={index}
                  flipped={audience === index}
                  onFlip={() => setAudience(audience === index ? null : index)}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="closing-section" aria-labelledby="closing-title">
          <div className="page-container closing-inner">
            <div className="closing-art" aria-hidden="true">
              <ForestLandscapeArtwork variant="homepage-closing" />
            </div>
            <div>
              <p className="eyebrow eyebrow-light">
                Learning today, brighter tomorrows
              </p>
              <h2 id="closing-title">Make the next step easier to see.</h2>
              <p className="closing-copy">
                Bring learning, practice, and progress together on a clearer
                path.
              </p>
            </div>
            <a className="button button-light" href="/register">
              Create your account <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>
      </main>

      <footer className="site-footer" id="about">
        <div className="page-container footer-inner">
          <BrandWordmark className="wordmark footer-wordmark" href="#home" />
          <p>A clearer path from learning to career readiness.</p>
          <a className="footer-top-link" href="#home">
            Back to top <span aria-hidden="true">↑</span>
          </a>
        </div>
      </footer>
    </>
  )
}
export default MarketingPage
