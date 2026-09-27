import { stubHandler } from "./registry";
/**
 * owner: T30. The ≤280-character mail gist, written by the student's own AI client when one is
 * connected (one checked call per message; the preview stays the text until then). A stub until
 * the runner wiring reaches the job drain: registered by whoever wires it, never enqueued while
 * `ready` is false. Kept out of the default registry so its pinned kind list is unchanged.
 */
export const mailGistJob = stubHandler("mail.gist", "resource", "T30");
