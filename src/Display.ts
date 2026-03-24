import { Context, Effect, Layer, Ref } from "effect";

export type Severity = "info" | "success" | "warn" | "error";

export type DisplayEntry =
  | {
      readonly _tag: "status";
      readonly message: string;
      readonly severity: Severity;
    }
  | { readonly _tag: "spinner"; readonly message: string }
  | {
      readonly _tag: "summary";
      readonly title: string;
      readonly rows: Record<string, string>;
    };

export interface DisplayService {
  readonly status: (message: string, severity: Severity) => Effect.Effect<void>;

  readonly spinner: <A, E, R>(
    message: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly summary: (
    title: string,
    rows: Record<string, string>,
  ) => Effect.Effect<void>;
}

export class Display extends Context.Tag("Display")<
  Display,
  DisplayService
>() {}

export const SilentDisplay = {
  layer: (ref: Ref.Ref<ReadonlyArray<DisplayEntry>>): Layer.Layer<Display> =>
    Layer.succeed(Display, {
      status: (message, severity) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "status" as const, message, severity },
        ]),

      spinner: (message, effect) =>
        Effect.flatMap(
          Ref.update(ref, (entries) => [
            ...entries,
            { _tag: "spinner" as const, message },
          ]),
          () => effect,
        ),

      summary: (title, rows) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "summary" as const, title, rows },
        ]),
    }),
};
