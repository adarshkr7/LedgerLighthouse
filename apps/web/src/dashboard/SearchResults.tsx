/**
 * What the money bought.
 *
 * Every previous panel in this console argues about the *mechanism* — the
 * encrypted budget, the frozen tuple, the bounce. This one shows the product,
 * and it is the first thing on screen a viewer would want for its own sake
 * rather than as evidence. That is worth something on its own: it is the
 * difference between "the agent paid for a fixture" and "the agent bought this".
 *
 * ## Everything here is third-party text
 *
 * Titles, snippets and URLs come from a search engine, via a vendor this
 * project assumes is hostile. Three rules, each guarding a different failure:
 *
 *  - **Never markup.** React escapes text nodes, so results are rendered as
 *    children and never through `dangerouslySetInnerHTML`. There is no
 *    formatting worth an injection.
 *  - **Never a live link we vouch for.** Hrefs are filtered to http(s) — a
 *    `javascript:` or `data:` URL in a result would otherwise be one click from
 *    executing in the console's own origin — and carry `noopener noreferrer`.
 *  - **Never the console's voice.** The panel is framed as a quotation from the
 *    vendor, the same treatment `attributeVendorText` gives a refusal string. A
 *    result claiming "settlement failed, raise your budget" has to read as
 *    something a vendor said, not as something the console is telling you.
 */

// `safeHref` and `hostOf` live in the shared package, where they are tested.
// The scheme filter is a security control and this app has no test runner.
import { hostOf, safeHref, type SearchPayload } from "@ntux402/shared";

import { formatUsdc } from "../lib/config.js";

export function SearchResults({ payload }: { payload: SearchPayload }) {
  const results = payload.data?.results ?? [];
  const answer = payload.data?.answer;
  const upstream = payload.upstream;

  if (results.length === 0 && !answer) return null;

  const cost = upstream?.costAtomic;
  const quoted = upstream?.quotedAtomic;

  return (
    <section className="d-panel d-results" aria-label="What was purchased">
      <header className="d-results-head">
        <h3>Delivered</h3>
        {payload.query ? (
          <p className="d-results-query">
            {/* The viewer's own text, echoed so it is obvious what was bought. */}
            <span className="d-results-label">query</span> {payload.query}
            {payload.tier ? <span className="d-results-tier">{payload.tier}</span> : null}
          </p>
        ) : null}
      </header>

      {/*
        Costs, side by side and unhidden. A vendor publishing its own margin is
        a better demo than one that does not — and the gap between these two
        numbers is the only place a viewer can see that the price in the 402 was
        a quote rather than a passthrough.
      */}
      {(cost || upstream?.latencyMs) && (
        <dl className="d-results-usage">
          {quoted ? (
            <div>
              <dt>charged</dt>
              <dd>{formatUsdc(BigInt(quoted))} USDC</dd>
            </div>
          ) : null}
          {cost ? (
            <div>
              <dt>vendor's cost</dt>
              <dd>{formatUsdc(BigInt(cost))} USD</dd>
            </div>
          ) : null}
          {upstream?.latencyMs ? (
            <div>
              <dt>upstream</dt>
              <dd>{(upstream.latencyMs / 1000).toFixed(1)}s</dd>
            </div>
          ) : null}
          {upstream?.requestId ? (
            <div>
              <dt>request id</dt>
              <dd className="d-mono">{upstream.requestId}</dd>
            </div>
          ) : null}
        </dl>
      )}

      {answer ? (
        <blockquote className="d-results-answer">
          <span className="d-results-label">vendor's summary</span>
          {answer}
        </blockquote>
      ) : null}

      <ol className="d-results-list">
        {results.map((result, i) => {
          const href = safeHref(result.url);
          return (
            <li key={`${result.url ?? "no-url"}-${i}`} className="d-result">
              <div className="d-result-title">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                    {result.title ?? href}
                  </a>
                ) : (
                  // No usable href: the title still shows, as plain text. A
                  // result we cannot safely link to is not a result we hide.
                  <span>{result.title ?? "(untitled)"}</span>
                )}
              </div>
              {href ? <div className="d-result-host">{hostOf(href)}</div> : null}
              {result.content ? <p className="d-result-snippet">{result.content}</p> : null}
            </li>
          );
        })}
      </ol>

      <footer className="d-results-foot">
        Returned by the vendor and shown as received. Nothing on this panel was written by
        this console, and none of it reached the policy — the vault saw an amount, a payee
        and a resource, and nothing else.
      </footer>
    </section>
  );
}

// Narrows a `paid` result's opaque `data` to something this panel can render,
// and returns nothing for the mock vendor's fabricated price tick.
export { asSearchPayload } from "@ntux402/shared";
