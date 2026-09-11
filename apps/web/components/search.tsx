// The header search box — a plain HTML form, so every docs page stays 0-JS. Submitting
// (Enter) navigates to /search?q=…, the one interactive route (see app/search/).
//
// Wide viewports: the box sits in the header, always visible; the ✕ is a `reset` button
// that only shows once there is text (CSS `:placeholder-shown`). Narrow viewports: only
// the magnifier button shows; it is a <label> for the input, so tapping it focuses the
// (visually collapsed) input and CSS `.topbar:has(.search-input:focus)` expands the form
// over the whole header — Google-docs style — until the search is submitted or the field
// loses focus (tap ✕ or anywhere else). No JavaScript in any of it.

export function MagnifierIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
    >
      <circle
        cx="10.5"
        cy="10.5"
        r="6.5"
        stroke="currentColor"
        stroke-width="2"
      />
      <path
        d="M15.5 15.5 21 21"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function ClearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
    >
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** The site-wide search form in the header (zero client JavaScript). */
export function SiteSearch() {
  return (
    <form class="search" role="search" action="/search" method="get">
      <label
        class="search-open"
        for="site-search-q"
        aria-label="Search the docs"
      >
        <MagnifierIcon />
      </label>
      <span class="search-icon">
        <MagnifierIcon />
      </span>
      <input
        id="site-search-q"
        class="search-input"
        type="search"
        name="q"
        placeholder="Search"
        autocomplete="off"
        spellcheck={false}
        aria-label="Search the docs"
      />
      <button type="reset" class="search-clear" aria-label="Clear search">
        <ClearIcon />
      </button>
    </form>
  );
}
