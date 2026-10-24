import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  addRefused,
  emptyRefused,
  loadRefused,
  refusedUnits,
  saveRefused,
  settleRefused,
  type RefusedRows,
} from "@wf-addons/kit";
import { refusedKey } from "../constants";
import type { ImportOutcome, ImportUnit } from "./importer";

/**
 * A connection's refused rows (see the kit's `refused-rows`): rows Wealthfolio refuses on every
 * call wait here, not behind the watermark. Every import's outcome is recorded (a unit that was
 * stored or is already there leaves the list, a refused one joins it or counts another attempt),
 * and the units still listed are sent again at the start of the next sync.
 */
export class RefusedRowsStore {
  private rows: RefusedRows = emptyRefused();
  private loaded = false;

  constructor(
    private readonly ctx: AddonContext,
    private readonly connectionId: string,
  ) {}

  private async ensure(): Promise<RefusedRows> {
    if (!this.loaded) {
      this.rows = await loadRefused(this.ctx.api.storage, refusedKey(this.connectionId));
      this.loaded = true;
    }
    return this.rows;
  }

  /** The units to send again: what earlier syncs left refused. */
  async pending(): Promise<ImportUnit[]> {
    return refusedUnits(await this.ensure());
  }

  /** What is refused now (after the last recorded import). */
  get current(): RefusedRows {
    return this.rows;
  }

  /** Records an import's outcome: settles what it stored or found there, adds what it refused. */
  async record(out: ImportOutcome): Promise<void> {
    let rows = await this.ensure();
    rows = settleRefused(rows, out.accounted);
    rows = addRefused(rows, out.refused);
    this.rows = await saveRefused(this.ctx.api.storage, refusedKey(this.connectionId), rows);
  }
}
