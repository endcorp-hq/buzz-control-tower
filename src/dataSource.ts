import { fixtureSnapshot } from "./fixtures";
import type { TowerSnapshot } from "./domain";

export interface TowerDataSource {
  readonly kind: TowerSnapshot["source"];
  loadSnapshot(): Promise<TowerSnapshot>;
}

class FixtureDataSource implements TowerDataSource {
  readonly kind = "fixture" as const;

  async loadSnapshot(): Promise<TowerSnapshot> {
    return structuredClone(fixtureSnapshot);
  }
}

export const dataSource: TowerDataSource = new FixtureDataSource();
