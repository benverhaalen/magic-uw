// owner: T06. The worker's direct (not through main) public network clients, gated on the
// setup consent record. main's consent gate covers every read the worker asks main for;
// these are the worker's own sockets: the external course-site crawl, document downloads
// and calendar feeds (ingestion), the Registrar pulls (planning refresh) and the Guide read
// (core `planning-guide`). Each refuses before opening a socket until the student agrees.
import type { Store } from "@magic/contracts";
import {
  createPublicClient,
  type PublicClient,
} from "../../../packages/connectors/src/network";
import {
  gatePublicClient,
  hasSetupConsent,
} from "../../../packages/core/src/egress";

export function createWorkerClients(
  store: Store,
  create: () => PublicClient = createPublicClient,
) {
  const consented = () => hasSetupConsent(store.consents?.());
  return {
    consented,
    /** `createIngestion`'s `client`. */
    ingestion: gatePublicClient(create(), consented),
    /** The worker's planning refresh (Registrar subjects and terms). */
    planning: gatePublicClient(create(), consented),
    /** `createCore`'s `planningPublicClient` (the Guide read). */
    core: gatePublicClient(create(), consented),
  };
}
