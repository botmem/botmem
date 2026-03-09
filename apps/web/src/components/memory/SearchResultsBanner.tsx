interface SearchResultsBannerProps {
  resolvedEntities: {
    contacts: { id: string; displayName: string }[];
    topicWords: string[];
    topicMatchCount: number;
  } | null;
  resultCount: number;
  searchFallback?: boolean;
  query?: string;
  parsed?: {
    temporal?: { from: string; to: string } | null;
    temporalFallback?: boolean;
    intent?: string;
  } | null;
}

export function SearchResultsBanner({
  resolvedEntities,
  resultCount,
  searchFallback,
  query,
  parsed,
}: SearchResultsBannerProps) {
  // Temporal filter banners
  if (parsed?.temporal && !parsed.temporalFallback) {
    const fromStr = new Date(parsed.temporal.from).toLocaleDateString();
    const toStr = new Date(parsed.temporal.to).toLocaleDateString();
    return (
      <>
        <div className="border-2 border-nb-blue/40 bg-nb-blue/10 px-4 py-2 mb-2">
          <p className="font-mono text-xs text-nb-blue">
            Filtered: <span className="font-bold text-nb-text">{fromStr}</span> to{' '}
            <span className="font-bold text-nb-text">{toStr}</span>
          </p>
        </div>
        {resolvedEntities && (
          <ResolvedEntitiesBanner resolvedEntities={resolvedEntities} resultCount={resultCount} />
        )}
      </>
    );
  }

  if (parsed?.temporalFallback) {
    return (
      <>
        <div className="border-2 border-nb-yellow/40 bg-nb-yellow/10 px-4 py-2 mb-2">
          <p className="font-mono text-xs text-nb-yellow">
            No results for that time range — showing all matches
          </p>
        </div>
        {resolvedEntities && (
          <ResolvedEntitiesBanner resolvedEntities={resolvedEntities} resultCount={resultCount} />
        )}
      </>
    );
  }

  if (resolvedEntities) {
    const names = resolvedEntities.contacts.map((c) => c.displayName).join(', ');
    const hasTopics = resolvedEntities.topicWords.length > 0;
    const topicStr = resolvedEntities.topicWords.join(' ');
    const noDirectMatches = hasTopics && resolvedEntities.topicMatchCount === 0;

    if (resultCount === 0) {
      return (
        <div className="border-2 border-nb-yellow/40 bg-nb-yellow/10 px-4 py-3 mb-2">
          <p className="font-mono text-xs text-nb-yellow">
            No memories found for <span className="font-bold text-nb-text">{names}</span>
            {hasTopics && (
              <>
                {' '}
                about <span className="font-bold text-nb-text">{topicStr}</span>
              </>
            )}
          </p>
        </div>
      );
    }

    if (noDirectMatches) {
      return (
        <div className="border-2 border-nb-yellow/40 bg-nb-yellow/10 px-4 py-3 mb-2">
          <p className="font-mono text-xs text-nb-yellow">
            No directly related memories found for{' '}
            <span className="font-bold text-nb-text">{names}</span> about{' '}
            <span className="font-bold text-nb-text">{topicStr}</span>. Showing closest matches.
          </p>
        </div>
      );
    }

    return (
      <div className="border-2 border-nb-blue/40 bg-nb-blue/10 px-4 py-3 mb-2">
        <p className="font-mono text-xs text-nb-blue">
          Showing results for <span className="font-bold text-nb-text">{names}</span>
          {hasTopics && (
            <>
              {' '}
              + <span className="font-bold text-nb-text">{topicStr}</span>
            </>
          )}
        </p>
      </div>
    );
  }

  if (searchFallback) {
    return (
      <div className="border-2 border-nb-yellow/40 bg-nb-yellow/10 px-4 py-3 mb-2">
        <p className="font-mono text-xs font-bold text-nb-yellow uppercase">No exact matches</p>
        <p className="font-mono text-xs text-nb-muted mt-1">
          No memories matched &quot;{query}&quot; by text or contact name. Showing semantically
          similar results instead.
        </p>
      </div>
    );
  }

  return null;
}

function ResolvedEntitiesBanner({
  resolvedEntities,
  resultCount,
}: {
  resolvedEntities: SearchResultsBannerProps['resolvedEntities'];
  resultCount: number;
}) {
  if (!resolvedEntities) return null;
  const names = resolvedEntities.contacts.map((c) => c.displayName).join(', ');
  const hasTopics = resolvedEntities.topicWords.length > 0;
  const topicStr = resolvedEntities.topicWords.join(' ');

  if (resultCount === 0) {
    return (
      <div className="border-2 border-nb-yellow/40 bg-nb-yellow/10 px-4 py-3 mb-2">
        <p className="font-mono text-xs text-nb-yellow">
          No memories found for <span className="font-bold text-nb-text">{names}</span>
          {hasTopics && (
            <>
              {' '}
              about <span className="font-bold text-nb-text">{topicStr}</span>
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="border-2 border-nb-blue/40 bg-nb-blue/10 px-4 py-3 mb-2">
      <p className="font-mono text-xs text-nb-blue">
        Showing results for <span className="font-bold text-nb-text">{names}</span>
        {hasTopics && (
          <>
            {' '}
            + <span className="font-bold text-nb-text">{topicStr}</span>
          </>
        )}
      </p>
    </div>
  );
}
