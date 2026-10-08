import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  convertDocument,
  quaternionToRotator,
  quaternionYawDegrees,
  rotatorToQuaternion,
  validateBackupStructure
} from "../docs/converter.js";

const root = new URL("../", import.meta.url);

function load(name) {
  return JSON.parse(readFileSync(new URL(name, root), "utf8"));
}

function angleDelta(a, b) {
  const delta = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return delta;
}

function countMap(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sameCounts(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

test("yaw-only quaternions match the solido rotation field", () => {
  for (const yaw of [0, 90, -90, 180, -180, 105, 15, -139]) {
    const quat = rotatorToQuaternion(0, yaw, 0);
    assert.ok(Math.abs(quat.x) < 1e-12);
    assert.ok(Math.abs(quat.y) < 1e-12);
    assert.ok(angleDelta(quaternionYawDegrees(quat.z, quat.w), yaw) < 1e-9);
  }
});

test("tilted placeable rotations survive a round trip", () => {
  for (const [pitch, yaw, roll] of [[10, 20, 30], [0, -95, 0], [-15, 40, 5]]) {
    const quat = rotatorToQuaternion(pitch, yaw, roll);
    const back = quaternionToRotator(quat.x, quat.y, quat.z, quat.w);
    assert.ok(angleDelta(back.pitch, pitch) < 1e-6, `pitch ${pitch} -> ${back.pitch}`);
    assert.ok(angleDelta(back.yaw, yaw) < 1e-6, `yaw ${yaw} -> ${back.yaw}`);
    assert.ok(angleDelta(back.roll, roll) < 1e-6, `roll ${roll} -> ${back.roll}`);
  }
});

test("the Home Base backup becomes the solido image of that same base", () => {
  const backup = load("Dame_Sabine_Dyvetz_Home_Base_base-backup_live_73.json");
  const solido = load("Dame_Sabine_Dyvetz_base_73.json");
  const converted = convertDocument(backup);

  assert.equal(converted.format, "solido");
  assert.equal(converted.document.base_id, solido.base_id);
  assert.equal(converted.document.name, solido.name);
  assert.equal(converted.document.base_type, solido.base_type);
  assert.equal(converted.document.owner_name, solido.owner_name);
  assert.equal(converted.document.map, solido.map);
  assert.equal(converted.document.x, solido.x);
  assert.equal(converted.document.y, solido.y);
  assert.equal(converted.document.z, solido.z);
  assert.equal(converted.document.piece_count, solido.piece_count);
  assert.equal(converted.document.placeable_count, solido.placeable_count);
  assert.deepEqual(converted.document.instances, solido.instances);
  assert.ok(sameCounts(
    countMap(converted.document.placeables, placeableKey),
    countMap(solido.placeables, placeableKey)
  ));
  assert.equal(converted.report.pieces, 1220);
  assert.equal(converted.report.placeables, 163);
  assert.match(converted.report.notes.join(" "), /1482 stored items/);
});

test("the Home Base solido becomes a valid backup and converts back", () => {
  const solido = load("Dame_Sabine_Dyvetz_base_73.json");
  const backup = convertDocument(solido);
  assert.equal(backup.format, "base-backup");
  assert.deepEqual(validateBackupStructure(backup.document), []);
  assert.equal(backup.document.source.totemType, "Totem_Placeable");
  assert.equal(backup.document.source.counts.pieces, 1220);
  assert.equal(backup.document.source.counts.placeables, 164);
  assert.equal(backup.document.source.counts.items, 0);

  const again = convertDocument(backup.document);
  assert.equal(again.document.piece_count, solido.piece_count);
  assert.equal(again.document.placeable_count, solido.placeable_count);
  assert.equal(again.document.base_type, solido.base_type);
  assert.equal(again.document.map, solido.map);
  for (let index = 0; index < solido.instances.length; index += 1) {
    const expected = solido.instances[index];
    const actual = again.document.instances[index];
    assert.equal(actual.building_type, expected.building_type);
    assert.equal(actual.instance_id, expected.instance_id);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-6);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-6);
    assert.ok(Math.abs(actual.z - expected.z) < 1e-6);
    assert.ok(angleDelta(actual.rotation, expected.rotation) < 1e-6);
  }
  assert.ok(closePlaceables(again.document.placeables, solido.placeables));
});

test("a small solido with a legacy yaw axis produces a linked backup", () => {
  const legacy = {
    name: "A very long outpost name that will not fit",
    map: "HaggaBasin",
    instances: [
      { instance_id: 4, building_type: "Atreides_Outpost_Floor", x: 10, y: 20, z: 30, rotation: -90 }
    ],
    placeables: [
      { placeable_id: "2", building_type: "StorageContainer_Placeable", x: 5, y: 6, z: 7, rx: 0, ry: 0, rz: 45 },
      { placeable_id: "9", building_type: "Totem_Placeable", x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      { building_type: "MysteryLamp_Placeable", x: 1, y: 2, z: 3, rx: 0, ry: 0, rz: 10 }
    ]
  };
  const backup = convertDocument(legacy, { claim: "small" });
  assert.deepEqual(validateBackupStructure(backup.document), []);
  assert.equal(backup.document.source.base_backup_name || backup.document.entries.find((entry) => entry.kind === "BaseBackup").data.base_backup_name.length <= 23, true);
  assert.equal(backup.document.source.totemType, "Totem_Small_Placeable");
  assert.match(backup.report.warnings.join(" "), /Older solido files/);
  assert.match(backup.report.warnings.join(" "), /MysteryLamp_Placeable/);
  assert.equal(backup.report.placeables, 2);

  const solido = convertDocument(backup.document);
  assert.equal(solido.document.base_type, "Sub-Fief");
  assert.equal(solido.document.instances[0].building_type, "Atreides_Outpost_Floor");
  assert.ok(angleDelta(solido.document.instances[0].rotation, -90) < 1e-6);
  const container = solido.document.placeables.find((row) => row.building_type === "StorageContainer_Placeable");
  assert.ok(container);
  assert.ok(angleDelta(container.ry, 45) < 1e-6);
  assert.equal(container.rx, 0);
  assert.equal(container.rz, 0);
  assert.equal(solido.document.placeables.some((row) => row.building_type === "Totem_Small_Placeable"), false);
});

test("rejects files that are neither format", () => {
  assert.throws(() => convertDocument({ hello: "world" }), /neither a solido image nor a dune-base-backup/);
});

test("fill water cisterns writes each cistern to its capacity", () => {
  const solido = {
    name: "Water Test",
    base_type: "Sub-Fief",
    map: "HaggaBasin",
    x: 0,
    y: 0,
    z: 0,
    instances: [
      { instance_id: 1, building_type: "Atreides_Outpost_Floor", x: 0, y: 0, z: 0, rotation: 0 }
    ],
    placeables: [
      { building_type: "WaterCistern_Placeable", x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      { building_type: "MediumWaterCistern_Placeable", x: 2, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      { building_type: "LargeWaterCistern_Placeable", x: 3, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      { building_type: "LargeWindtrap_Placeable", x: 4, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      { building_type: "Deathstill_Placeable", x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }
    ]
  };

  const empty = convertDocument(solido, { claim: "small" });
  assert.deepEqual(storedWater(empty.document), {
    WaterCistern_Placeable: [0],
    MediumWaterCistern_Placeable: [0],
    LargeWaterCistern_Placeable: [0],
    Deathstill_Placeable: [0]
  });
  assert.match(empty.report.notes.join(" "), /3 water cisterns left empty/);

  const full = convertDocument(solido, { claim: "small", fillWater: true });
  assert.deepEqual(validateBackupStructure(full.document), []);
  assert.deepEqual(storedWater(full.document), {
    WaterCistern_Placeable: [5000],
    MediumWaterCistern_Placeable: [25000],
    LargeWaterCistern_Placeable: [100000],
    Deathstill_Placeable: [0]
  });
  assert.equal(storedWater(full.document).LargeWindtrap_Placeable, undefined);
  assert.match(full.report.notes.join(" "), /3 water cisterns filled \(130,000 water\)/);
});

function storedWater(backup) {
  const byActor = new Map();
  for (const entry of backup.entries) {
    if (entry.kind !== "Placeable") continue;
    byActor.set(entry.data.id, entry.data.building_type);
  }
  const amounts = {};
  for (const entry of backup.entries) {
    if (entry.kind !== "fgl") continue;
    const stored = entry.data.components?.FWaterStorageComponent?.[1]?.m_WaterStored;
    if (stored == null) continue;
    const buildingType = byActor.get(entry.data.actor_id);
    amounts[buildingType] = amounts[buildingType] || [];
    amounts[buildingType].push(stored);
  }
  return amounts;
}

function placeableKey(row) {
  return [row.building_type, row.x, row.y, row.z, row.rx, row.ry, row.rz].join("|");
}

function closePlaceables(actualRows, expectedRows) {
  const used = new Set();
  return expectedRows.every((expected) => {
    const index = actualRows.findIndex((actual, actualIndex) => {
      if (used.has(actualIndex) || actual.building_type !== expected.building_type) return false;
      return Math.abs(actual.x - expected.x) < 1e-4
        && Math.abs(actual.y - expected.y) < 1e-4
        && Math.abs(actual.z - expected.z) < 1e-4
        && angleDelta(actual.ry, expected.ry) < 1e-4
        && Math.abs(actual.rx - expected.rx) < 1e-4
        && Math.abs(actual.rz - expected.rz) < 1e-4;
    });
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}
