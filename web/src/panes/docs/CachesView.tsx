/**
 * The Project pane's Caches tab (issue #285; moved off the reference pane's
 * own tab strip onto this shared-slot surface by issue #306, see
 * `panes/docs/DocsPane.tsx`): a short, honest answer to a
 * question this app never used to answer anywhere -- what does this editor
 * cache, how fresh is it, and does anything refresh on its own?
 *
 * The owner asked three separate, specific versions of that question, live:
 *
 * > *"For the orb section in the palette, I saw a little warning that says
 * > some of these are cached, and the cache might be more than a day old.
 * > But when I go to context, there's a little refresh button that lets me
 * > refresh the contexts. Do we need one of those for the orb section?"*
 * >
 * > *"Are we refreshing the Docker images, the machine images, or versions,
 * > and all that stuff as well, on a recurring basis?"*
 * >
 * > *"It has that badge CircleCI docs offline. It's cool that it's offline.
 * > But is there a refresh button that we could do that would cause it to
 * > pull in new stuff?"*
 *
 * That last one is the tell: "offline" reads as "frozen" unless something
 * says otherwise. Contexts already had an answer (the palette's own Refresh
 * button); orbs, guides and Docker Hub tags didn't, until this issue. This
 * tab is where every cache this app keeps gets named in one place, each with
 * what actually happens to it -- rather than the answer only being
 * discoverable by finding each button separately and reading its tooltip.
 * (Deliberately not a count in this sentence: it has already drifted once,
 * as #305 and #307 each added an entry after this was written.)
 *
 * ## Verified from the code, not assumed
 *
 * Every TTL/window named below is read from the constant that enforces it
 * (`orbs.RefreshWindow`, `guides.refreshTTL`/`NoRefreshEnvVar`,
 * `dockerhub.cacheTTL`), not from memory of what it might be -- see each
 * cache's own package for the source of truth if either drifts.
 */
import { DocsLink } from '~/design/components/DocsLink';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';

interface CacheEntry {
  name: string;
  /** What this cache actually holds, in plain terms. */
  holds: string;
  /**
   * What keeps it current with no user action -- or, honestly, that nothing
   * does. Never says "always fresh": every one of these is a cache, and the
   * whole point of this tab is not overstating that away.
   */
  autoRefresh: string;
  /** Where the manual "check now" button lives, or why there isn't one. */
  manualRefresh: string;
  link?: { label: string; url: string };
}

const CACHES: CacheEntry[] = [
  {
    name: 'Contexts & project settings',
    holds:
      "This project's organization contexts, its environment variable names, and the handful of project settings that change how a config behaves (issue #105). Values are never fetched -- only names and, for context variables, a four-character preview.",
    autoRefresh:
      "Cached for a short time per session so re-opening the palette's Contexts section doesn't re-fetch on every click.",
    manualRefresh:
      'Yes -- the "Refresh" button at the top of the palette’s Contexts section.',
    link: DOCS_LINKS.workflows.contexts,
  },
  {
    name: 'Orb registry',
    holds:
      'A locally searchable copy of the CircleCI orb registry (~6,400 public orbs, plus any private orbs this host’s token can see) -- what the palette’s Orbs section searches.',
    autoRefresh:
      'Warmed once when this app starts, then re-crawled automatically the next time it starts if that copy is more than 7 days old. An old copy is still served (labelled stale), never blanked, while a re-crawl runs.',
    manualRefresh:
      'Yes -- the "Refresh" button in the palette’s Orbs section. A full re-crawl can take a few minutes; the button disables itself while one is already running, so clicking it twice never starts a second crawl.',
    link: DOCS_LINKS.orbs.registry,
  },
  {
    name: 'Documentation guides',
    holds:
      "CircleCI's own configuration-reference prose, rendered in the Guides tab -- plus, derived from that exact same source, the resource-class lists the executor field offers and the supported-Xcode-version list the Xcode field offers. All three ship inside this binary and work fully offline; “offline” describes that, not that they never update.",
    autoRefresh:
      'Checks upstream in the background every 7 days. A failed check leaves the previous copy in place, labelled, never blank.',
    manualRefresh:
      'Yes -- the "Refresh" button in the Guides tab’s footer. Refreshing the guides refreshes the resource-class and Xcode lists too, since all three are parsed from the one snapshot.',
    link: DOCS_LINKS.guides.configurationReference,
  },
  {
    name: 'Docker Hub tags (cimg/* images)',
    holds:
      "Recent published version tags for whichever cimg/* convenience image is open in a job's Docker executor field -- fetched per image, not all at once.",
    autoRefresh:
      "Each image's tag list is cached for 12 hours after it's first looked up, then re-fetched the next time that image's picker is opened.",
    manualRefresh:
      'Yes -- the "Refresh" button next to the version-tag field in the Docker image picker.',
    link: DOCS_LINKS.images.dockerConvenience,
  },
  {
    name: 'Machine images',
    holds:
      "CircleCI's live machine-image catalog (issue #305) -- which images are offered for which resource class, and which are deprecated. Fetched from CircleCI's own API on first use by the machine-image picker; falls back to a hand-curated literal built into this app when the catalog has never been reachable.",
    autoRefresh:
      'Each fetch is cached for 24 hours, then re-fetched the next time the picker is opened. A fetch failure keeps serving the previous catalog, labelled stale, rather than falling back early.',
    manualRefresh:
      'Yes -- the "Refresh" button next to the machine-image picker.',
    link: DOCS_LINKS.images.machineTags,
  },
  {
    name: 'Usage (for resource-class suggestions)',
    holds:
      "Per-job CPU/RAM utilisation, resource class, and credits, from CircleCI's Usage Export API -- what powers the palette's \"consider a different resource class\" suggestions (issue #307). Read this carefully: the Usage API has no per-project filter, so producing this means downloading usage data for every project in your organisation, not just this one -- this app never sends that data anywhere else, keeps only the reduced per-job/per-day numbers (never the raw export), and only ever shows you this project's own jobs.",
    autoRefresh:
      "Warmed in the background the first time this app starts, then delta-fetched on every later start: only the gap since the last fetch, capped at the configured window (7 days by default, 14 or 30 also available) and never extended past the last fully-complete day, since a run still in progress hasn't finished costing what it's going to cost. An old summary is still served, labelled stale, while a refresh runs.",
    manualRefresh:
      'Yes -- the "Refresh" button next to the resource-class suggestions. Usage export can take a while for a large organisation over a wide window; the button disables itself while one is already running.',
    link: DOCS_LINKS.executors.resourceClass,
  },
];

function CacheRow({ entry }: { entry: CacheEntry }) {
  return (
    <li className="rounded-md border border-cc-border-strong bg-cc-panel-raised p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-cc-text">{entry.name}</p>
        {entry.link ? (
          <a
            href={entry.link.url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-2xs text-cc-accent hover:underline"
          >
            {entry.link.label} ↗
          </a>
        ) : null}
      </div>
      <p className="mt-1 text-2xs text-cc-text-muted">{entry.holds}</p>
      <dl className="mt-1.5 space-y-0.5">
        <div className="flex gap-1.5 text-2xs">
          <dt className="shrink-0 font-medium text-cc-text-faint">
            Refreshes itself:
          </dt>
          <dd className="text-cc-text-muted">{entry.autoRefresh}</dd>
        </div>
        <div className="flex gap-1.5 text-2xs">
          <dt className="shrink-0 font-medium text-cc-text-faint">
            Manual refresh:
          </dt>
          <dd className="text-cc-text-muted">{entry.manualRefresh}</dd>
        </div>
      </dl>
    </li>
  );
}

export function CachesView() {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-3"
      data-testid="caches-view"
    >
      <p className="mb-3 text-2xs text-cc-text-muted">
        This app keeps a local copy of several things CircleCI (or Docker Hub)
        would otherwise have to be asked for on every keystroke. Each one below
        says honestly how fresh it is, whether it updates itself, and where to
        force an update sooner.
      </p>
      <ul className="space-y-2">
        {CACHES.map((entry) => (
          <CacheRow key={entry.name} entry={entry} />
        ))}
      </ul>
      <div className="mt-3 rounded-md border border-cc-border-strong bg-cc-panel-raised p-2.5">
        <p className="text-2xs font-semibold text-cc-text">
          What backs the machine-image list now
        </p>
        <p className="mt-1 text-2xs text-cc-text-muted">
          Issue #305: CircleCI turns out to publish exactly the listing API this
          pane used to say it didn&rsquo;t (
          <code>GET /api/v3/catalog/offerings</code>, unauthenticated). The
          picker now fetches it directly, and uses it to hide an image the
          catalog doesn&rsquo;t offer for the job&rsquo;s resource class and to
          flag one CircleCI has deprecated. The literal this app used to
          maintain by hand for{' '}
          <DocsLink {...DOCS_LINKS.images.machineTags}>
            the configuration reference&apos;s own table
          </DocsLink>{' '}
          is kept as the offline fallback: a correct built-in list still beats a
          live request that can&rsquo;t be made, which is exactly why it stays
          rather than being deleted now that a live source exists.
        </p>
      </div>
    </div>
  );
}
