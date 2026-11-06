/**
 * LandingPage Component
 * Public-facing marketing page for AtlasEngine.
 * Hero section, features grid, product visualization, pricing, download CTA, footer.
 */

interface LandingPageProps {
  onOpenApp: () => void;
}

function LandingPage({ onOpenApp }: LandingPageProps) {
  return (
    <div className="min-h-screen bg-surface-base text-content" style={{ scrollBehavior: 'smooth' }}>
      {/* ─── Sticky Navigation ─── */}
      <nav className="sticky top-0 z-50 bg-surface-base/80 backdrop-blur-lg border-b border-border-muted/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
              <svg
                className="w-5 h-5 text-content"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                />
              </svg>
            </div>
            <span className="text-lg font-bold text-content">AtlasEngine</span>
          </div>

          {/* Nav Links */}
          <div className="hidden sm:flex items-center gap-6">
            <a href="#features" className="text-sm text-content-secondary hover:text-content transition-colors">Features</a>
            <a href="#pricing" className="text-sm text-content-secondary hover:text-content transition-colors">Pricing</a>
            <a href="#download" className="text-sm text-content-secondary hover:text-content transition-colors">Download</a>
            <button
              onClick={onOpenApp}
              className="px-4 py-2 text-sm font-medium text-content bg-surface hover:bg-surface-hover border border-border rounded-lg transition-colors"
            >
              Open App
            </button>
          </div>

          {/* Mobile menu button */}
          <button
            onClick={onOpenApp}
            className="sm:hidden px-3 py-1.5 text-sm font-medium text-content bg-surface hover:bg-surface-hover border border-border rounded-lg transition-colors"
          >
            Open App
          </button>
        </div>
      </nav>

      {/* ─── Hero Section ─── */}
      <section className="relative overflow-hidden">
        {/* Background gradient glow */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-blue-500/10 rounded-full blur-[120px]" />
          <div className="absolute top-1/3 left-1/3 w-[400px] h-[400px] bg-purple-600/10 rounded-full blur-[100px]" />
        </div>

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-24 sm:pt-28 sm:pb-32">
          <div className="text-center max-w-3xl mx-auto">
            {/* Claude Code badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 mb-8 bg-purple-500/10 border border-purple-500/20 rounded-full">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
              <span className="text-sm text-purple-300">Already using Claude Code? Reviews work instantly.</span>
            </div>

            {/* Headline */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
              <span className="bg-gradient-to-r from-blue-400 via-purple-400 to-blue-400 bg-clip-text text-transparent">
                Atlas Review
              </span>
              <br />
              <span className="text-content">for AI-Generated Code</span>
            </h1>

            {/* Subheadline */}
            <p className="text-lg sm:text-xl text-content-secondary mb-10 max-w-2xl mx-auto leading-relaxed">
              Review every AI change before it reaches production. Run verification and publish from Atlas Builder when you're ready to ship. Works with Claude Code, Codex, Cursor, Copilot and more.
            </p>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
              <a
                href="#download"
                className="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-content font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 text-center"
              >
                Download for macOS
              </a>
              <a
                href="#features"
                className="w-full sm:w-auto px-8 py-3.5 bg-surface/80 hover:bg-surface-hover/80 text-content font-semibold rounded-xl border border-border transition-colors text-center"
              >
                Learn More
              </a>
            </div>
          </div>

          {/* Hero Visual — Pipeline Steps */}
          <div className="max-w-3xl mx-auto">
            <div className="relative bg-surface-base/60 backdrop-blur border border-border-muted rounded-2xl p-6 sm:p-8">
              {/* Product header */}
              <div className="text-center mb-6">
                <p className="text-xs uppercase tracking-widest text-content-tertiary font-medium">Atlas Review + Builder</p>
              </div>

              {/* Pipeline steps */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 sm:gap-2">
                {/* Step 1: Detect */}
                <div className="flex sm:flex-col items-center gap-3 sm:gap-2 text-center">
                  <div className="w-12 h-12 rounded-xl bg-blue-500/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-accent-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </div>
                  <div className="sm:mt-1">
                    <p className="text-sm font-semibold text-blue-300">Detect</p>
                    <p className="text-xs text-content-tertiary mt-0.5 hidden sm:block">Auto-detect changes</p>
                  </div>
                </div>

                {/* Connector (desktop) */}
                <div className="hidden sm:flex items-center justify-center -mx-2 relative" style={{ gridColumn: 'auto', position: 'absolute', left: '25%', right: '75%', top: '42%' }}>
                </div>

                {/* Step 2: Review */}
                <div className="flex sm:flex-col items-center gap-3 sm:gap-2 text-center">
                  <div className="w-12 h-12 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                    </svg>
                  </div>
                  <div className="sm:mt-1">
                    <p className="text-sm font-semibold text-purple-300">Review</p>
                    <p className="text-xs text-content-tertiary mt-0.5 hidden sm:block">AI risk scoring</p>
                  </div>
                </div>

                {/* Step 3: Verify */}
                <div className="flex sm:flex-col items-center gap-3 sm:gap-2 text-center">
                  <div className="w-12 h-12 rounded-xl bg-green-500/20 border border-green-500/30 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                  </div>
                  <div className="sm:mt-1">
                    <p className="text-sm font-semibold text-green-300">Verify</p>
                    <p className="text-xs text-content-tertiary mt-0.5 hidden sm:block">In Atlas Builder</p>
                  </div>
                </div>

                {/* Step 4: Ship */}
                <div className="flex sm:flex-col items-center gap-3 sm:gap-2 text-center">
                  <div className="w-12 h-12 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                    </svg>
                  </div>
                  <div className="sm:mt-1">
                    <p className="text-sm font-semibold text-amber-300">Ship</p>
                    <p className="text-xs text-content-tertiary mt-0.5 hidden sm:block">Publish from Builder</p>
                  </div>
                </div>
              </div>

              {/* Animated gradient connector line (desktop only) */}
              <div className="hidden sm:block absolute left-[calc(12.5%+24px)] right-[calc(12.5%+24px)] top-[calc(50%-2px)] h-0.5 -mt-3">
                <div
                  className="h-full rounded-full"
                  style={{
                    background: 'linear-gradient(90deg, #3b82f6, #8b5cf6, #22c55e, #f59e0b)',
                    opacity: 0.4,
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Features Grid ─── */}
      <section id="features" className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-content mb-4">
              Review AI code without changing your workflow
            </h2>
            <p className="text-lg text-content-secondary max-w-2xl mx-auto">
              Atlas Review catches risky changes early. Atlas Builder handles verification and publish when you're ready.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Feature 1: Auto-Detect Changes */}
            <div className="group bg-surface-base/50 border border-border-muted hover:border-blue-500/30 rounded-xl p-6 transition-all hover:shadow-lg hover:shadow-blue-500/5">
              <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center mb-4">
                <svg className="w-5 h-5 text-accent-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-content mb-2">Auto-Detect Changes</h3>
              <p className="text-content-secondary text-sm leading-relaxed">
                Watch for AI commits from any tool — Claude Code, GitHub Copilot, Cursor, Codex. Changes appear automatically.
              </p>
            </div>

            {/* Feature 2: AI-Powered Reviews */}
            <div className="group bg-surface-base/50 border border-border-muted hover:border-purple-500/30 rounded-xl p-6 transition-all hover:shadow-lg hover:shadow-purple-500/5">
              <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center mb-4">
                <svg className="w-5 h-5 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-content mb-2">AI-Powered Reviews</h3>
              <p className="text-content-secondary text-sm leading-relaxed">
                Every change gets a structured review with risk scoring, inline findings, and suggested fixes.
              </p>
            </div>

            {/* Feature 3: Builder Verification */}
            <div className="group bg-surface-base/50 border border-border-muted hover:border-green-500/30 rounded-xl p-6 transition-all hover:shadow-lg hover:shadow-green-500/5">
              <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center mb-4">
                <svg className="w-5 h-5 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-content mb-2">Builder Verification</h3>
              <p className="text-content-secondary text-sm leading-relaxed">
                Run project checks from Atlas Builder and gate publish on passing verification.
              </p>
            </div>

            {/* Feature 4: Builder Publish */}
            <div className="group bg-surface-base/50 border border-border-muted hover:border-amber-500/30 rounded-xl p-6 transition-all hover:shadow-lg hover:shadow-amber-500/5">
              <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center mb-4">
                <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-content mb-2">Builder Publish</h3>
              <p className="text-content-secondary text-sm leading-relaxed">
                Publish or rollback from Atlas Builder with a full audit trail.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Social Proof ─── */}
      <div className="border-y border-border-muted/50 py-8">
        <p className="text-center text-content-tertiary text-sm tracking-wide">
          Works with your existing workflow — no config changes needed.
        </p>
      </div>

      {/* ─── How It Works ─── */}
      <section className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-content mb-4">
              How it works
            </h2>
            <p className="text-lg text-content-secondary max-w-2xl mx-auto">
              Atlas Review handles review first. Atlas Builder handles verification and publish when you are ready.
            </p>
          </div>

          {/* Pipeline steps */}
          <div className="relative max-w-4xl mx-auto">
            {/* Connecting line (desktop) */}
            <div className="hidden md:block absolute top-12 left-[calc(12.5%+20px)] right-[calc(12.5%+20px)] h-0.5">
              <div
                className="h-full rounded-full"
                style={{
                  background: 'linear-gradient(90deg, #3b82f6 0%, #8b5cf6 33%, #22c55e 66%, #f59e0b 100%)',
                  opacity: 0.3,
                }}
              />
            </div>

            {/* Connecting line (mobile — vertical) */}
            <div className="md:hidden absolute left-6 top-12 bottom-12 w-0.5">
              <div
                className="w-full h-full rounded-full"
                style={{
                  background: 'linear-gradient(180deg, #3b82f6 0%, #8b5cf6 33%, #22c55e 66%, #f59e0b 100%)',
                  opacity: 0.3,
                }}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-8 md:gap-4 relative">
              {/* Step 1: Detect */}
              <div className="flex md:flex-col items-start md:items-center gap-4 md:gap-3 md:text-center">
                <div className="w-12 h-12 rounded-xl bg-blue-500/20 border-2 border-blue-500/40 flex items-center justify-center flex-shrink-0 relative z-10">
                  <svg className="w-6 h-6 text-accent-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2 md:justify-center mb-1">
                    <span className="text-xs font-mono text-accent-blue/60">01</span>
                    <h3 className="text-base font-semibold text-blue-300">Detect</h3>
                  </div>
                  <p className="text-sm text-content-secondary leading-relaxed">
                    AI commits detected automatically via git watcher. No hooks or plugins required.
                  </p>
                </div>
              </div>

              {/* Step 2: Review */}
              <div className="flex md:flex-col items-start md:items-center gap-4 md:gap-3 md:text-center">
                <div className="w-12 h-12 rounded-xl bg-purple-500/20 border-2 border-purple-500/40 flex items-center justify-center flex-shrink-0 relative z-10">
                  <svg className="w-6 h-6 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2 md:justify-center mb-1">
                    <span className="text-xs font-mono text-accent-purple/60">02</span>
                    <h3 className="text-base font-semibold text-purple-300">Review</h3>
                  </div>
                  <p className="text-sm text-content-secondary leading-relaxed">
                    Structured AI review with risk scoring, inline findings, and suggested fixes.
                  </p>
                </div>
              </div>

              {/* Step 3: Verify */}
              <div className="flex md:flex-col items-start md:items-center gap-4 md:gap-3 md:text-center">
                <div className="w-12 h-12 rounded-xl bg-green-500/20 border-2 border-green-500/40 flex items-center justify-center flex-shrink-0 relative z-10">
                  <svg className="w-6 h-6 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2 md:justify-center mb-1">
                    <span className="text-xs font-mono text-accent-green/60">03</span>
                    <h3 className="text-base font-semibold text-green-300">Verify</h3>
                  </div>
                  <p className="text-sm text-content-secondary leading-relaxed">
                    Run project-specific verification in Atlas Builder before publishing.
                  </p>
                </div>
              </div>

              {/* Step 4: Ship */}
              <div className="flex md:flex-col items-start md:items-center gap-4 md:gap-3 md:text-center">
                <div className="w-12 h-12 rounded-xl bg-amber-500/20 border-2 border-amber-500/40 flex items-center justify-center flex-shrink-0 relative z-10">
                  <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2 md:justify-center mb-1">
                    <span className="text-xs font-mono text-amber-400/60">04</span>
                    <h3 className="text-base font-semibold text-amber-300">Ship</h3>
                  </div>
                  <p className="text-sm text-content-secondary leading-relaxed">
                    Publish or rollback from Atlas Builder with a full audit trail.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Pricing ─── */}
      <section id="pricing" className="py-20 sm:py-28 border-t border-border-muted/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-content mb-4">
              Simple, transparent pricing
            </h2>
            <p className="text-lg text-content-secondary">
              Start free. Upgrade when you need more.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-3xl mx-auto">
            {/* Free Tier */}
            <div className="bg-surface-base/50 border border-border-muted rounded-2xl p-8 flex flex-col">
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-content mb-1">Free</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold text-content">$0</span>
                  <span className="text-content-tertiary">/month</span>
                </div>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  20 reviews per month
                </li>
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  1 project
                </li>
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  All core features
                </li>
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Community support
                </li>
              </ul>
              <button
                onClick={onOpenApp}
                className="w-full py-3 bg-surface hover:bg-surface-hover text-content font-semibold rounded-xl border border-border transition-colors"
              >
                Get Started Free
              </button>
            </div>

            {/* Pro Tier */}
            <div className="relative bg-surface-base/50 border-2 border-purple-500/40 rounded-2xl p-8 flex flex-col shadow-lg shadow-purple-500/5">
              {/* Badge */}
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="px-3 py-1 bg-gradient-to-r from-blue-500 to-purple-600 text-content text-xs font-semibold rounded-full">
                  Most Popular
                </span>
              </div>

              <div className="mb-6">
                <h3 className="text-lg font-semibold text-content mb-1">Pro</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold text-content">$12</span>
                  <span className="text-content-tertiary">/month</span>
                </div>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-purple flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Unlimited reviews
                </li>
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-purple flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Unlimited projects
                </li>
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-purple flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Priority support
                </li>
                <li className="flex items-center gap-2.5 text-sm text-content">
                  <svg className="w-4 h-4 text-accent-purple flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Early access to new features
                </li>
              </ul>
              <a
                href="#download"
                className="w-full py-3 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-content font-semibold rounded-xl text-center transition-all shadow-lg shadow-purple-500/20"
              >
                Start Pro Trial
              </a>
            </div>
          </div>

          <p className="text-center text-sm text-content-tertiary mt-8">
            No credit card required for free tier.
          </p>
        </div>
      </section>

      {/* ─── Download CTA ─── */}
      <section id="download" className="py-20 sm:py-28 border-t border-border-muted/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-content mb-4">
            Ready to trust your AI-generated code?
          </h2>
          <p className="text-lg text-content-secondary mb-10 max-w-xl mx-auto">
            Download AtlasEngine and start reviewing AI changes in minutes.
          </p>

          <div className="flex flex-col items-center gap-4">
            <a
              href="https://github.com/AtlasEngine/AtlasEngineMVP/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-3 px-10 py-4 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-content font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 text-lg"
            >
              {/* Apple logo */}
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
              </svg>
              Download for macOS
            </a>

            <p className="text-sm text-content-tertiary">
              macOS 12+ (Apple Silicon &amp; Intel). Windows coming soon.
            </p>

            <button
              onClick={onOpenApp}
              className="text-sm text-accent-blue hover:text-accent-blue transition-colors mt-2"
            >
              Or try the web version &rarr;
            </button>
          </div>
        </div>
      </section>

      {/* ─── Footer ─── */}
      <footer className="border-t border-border-muted/50 py-12">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            {/* Logo + tagline */}
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-content"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                  />
                </svg>
              </div>
              <span className="text-sm text-content-tertiary">AI code review with Builder verification and publish</span>
            </div>

            {/* Links */}
            <div className="flex items-center gap-6">
              <a
                href="https://github.com/AtlasEngine/AtlasEngineMVP"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-content-tertiary hover:text-content transition-colors"
              >
                GitHub
              </a>
              <a href="#features" className="text-sm text-content-tertiary hover:text-content transition-colors">
                Documentation
              </a>
              <a href="#pricing" className="text-sm text-content-tertiary hover:text-content transition-colors">
                Pricing
              </a>
              <a href="#" className="text-sm text-content-tertiary hover:text-content transition-colors">
                Privacy
              </a>
            </div>
          </div>

          <div className="mt-8 text-center">
            <p className="text-xs text-content-tertiary">
              Built by AtlasEngine &middot; &copy; {new Date().getFullYear()} All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default LandingPage;
