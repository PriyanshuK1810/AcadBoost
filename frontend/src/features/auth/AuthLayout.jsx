import BrandWordmark from '../../app/BrandWordmark'

export default function AuthLayout({ eyebrow, title, intro, children }) {
  return (
    <main className="auth-page">
      <header className="auth-header page-container">
        <BrandWordmark className="wordmark" href="/" />
        <a className="auth-home-link" href="/login">
          Back to sign in ↗
        </a>
      </header>
      <div className="auth-layout page-container">
        <aside className="auth-story">
          <p className="eyebrow eyebrow-light">Your journey, your account</p>
          <h2>Keep your next step within reach.</h2>
          <p>
            One account connects your learning journey and progress across
            Acadboost.
          </p>
          <div className="auth-story-footer">
            <span className="auth-story-marker">01</span>
            <span>Learn with purpose. Grow with confidence.</span>
          </div>
        </aside>
        <section className="auth-card" aria-labelledby="auth-title">
          <p className="eyebrow">{eyebrow}</p>
          <h1 id="auth-title">{title}</h1>
          <p className="auth-intro">{intro}</p>
          {children}
        </section>
      </div>
    </main>
  )
}
