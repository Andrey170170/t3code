import * as Semaphore from "effect/Semaphore";

// Both import entry points install native bindings before projecting a thread.
// Serialize that interval so a concurrent legacy/native import cannot adopt
// the same conversation through different provider-instance aliases.
export const agentSessionImportLock = Semaphore.makeUnsafe(1);
