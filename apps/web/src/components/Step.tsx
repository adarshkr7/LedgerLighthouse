import type { ReactNode } from "react";

export type StepState = "ready" | "done" | "blocked";

/**
 * One numbered step of the protocol. The demo reads top to bottom like a
 * printed procedure, because that is what it is.
 */
export function Step(props: {
  n: number;
  title: string;
  blurb?: string;
  state: StepState;
  children: ReactNode;
}) {
  return (
    <section className="step" data-state={props.state}>
      <div className="step-number">{String(props.n).padStart(2, "0")}</div>
      <div className="step-body">
        <h2>{props.title}</h2>
        {props.blurb ? <p>{props.blurb}</p> : null}
        {props.children}
      </div>
    </section>
  );
}

export function Badge(props: { tone: "approve" | "reject" | "pending" | "neutral"; children: ReactNode }) {
  return (
    <span className="badge" data-tone={props.tone}>
      {props.children}
    </span>
  );
}

/** Full value in the title attribute — a truncated hash you cannot copy is decoration. */
export function Hash(props: { value: string; label?: string }) {
  return (
    <code className="handle" title={props.value}>
      {props.label ? `${props.label} ` : ""}
      {props.value}
    </code>
  );
}
