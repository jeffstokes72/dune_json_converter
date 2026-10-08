import {
  BUILDING_ACTOR_CLASS,
  CLASS_BY_TYPE,
  GAME_PROFILE,
  INVENTORIES,
  PIECE_HEALTH,
  PLACEABLE_HEALTH,
  cisternCapacity
} from "./catalog.js";

const CLAIM_TYPES = new Set(["totem_placeable", "totem_small_placeable"]);
const BACKUP_NAME_MAX = 23;
const YAW_ONLY_EPSILON = 1e-4;

const ENTRY_REFS = {
  act: {},
  fgl: { actor_id: "act" },
  PermissionActor: { actor_id: "act" },
  PermissionActorRank: { permission_actor_id: "act", player_id: "actOrOwner" },
  inv: { actor_id: "act" },
  itm: { inventory_id: "inv" },
  ActorInventory: { inventory_id: "inv" },
  Building: { id: "act" },
  BuildingInstance: { building_id: "act", owner_entity_id: "fgl?" },
  Placeable: { id: "act", owner_entity_id: "fgl?" },
  Totem: { id: "act" },
  BaseBackup: { player_id: "owner" },
  BaseBackupLinkedActor: { id: "BaseBackup", actor_id: "act" },
  LandclaimSegment: { totem_id: "act" },
  TaxInvoice: { totem_id: "act" },
  Sinkchart: { item_id: "itm" },
  bbp: { item_id: "itm", player_id: "absent" },
  BuildingBlueprintInstance: { building_blueprint_id: "bbp" },
  BuildingBlueprintPlaceable: { building_blueprint_id: "bbp" },
  BuildingBlueprintPentashield: { building_blueprint_id: "bbp" }
};

const ALLOWED_KINDS = new Set(Object.keys(ENTRY_REFS));

export function detectFormat(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (doc.format === "dune-base-backup" && Array.isArray(doc.entries)) return "base-backup";
  if (Array.isArray(doc.instances) || Array.isArray(doc.placeables) || Array.isArray(doc.pentashields)) {
    return "solido";
  }
  return null;
}

export function convertDocument(doc, options = {}) {
  const format = detectFormat(doc);
  if (format === "base-backup") {
    const { document, report } = backupToSolido(doc);
    return { format: "solido", document, report };
  }
  if (format === "solido") {
    const { document, report } = solidoToBackup(doc, options);
    return { format: "base-backup", document, report };
  }
  throw new Error("This JSON is neither a solido image nor a dune-base-backup file.");
}

export function backupToSolido(doc) {
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const byId = new Map();
  for (const entry of entries) {
    if (entry && Number.isInteger(entry.id)) byId.set(entry.id, entry);
  }

  const totem = entries.find((entry) => entry?.kind === "Totem");
  if (!totem?.data) throw new Error("This base backup has no claim console, so it cannot be turned into a solido image.");
  const totemActorId = positiveId(totem.data.id);
  const totemActor = byId.get(totemActorId);
  if (!totemActor || totemActor.kind !== "act" || !totemActor.data?.transform?.location) {
    throw new Error("This base backup's claim console has no location.");
  }

  const anchor = totemActor.data.transform.location;
  const source = doc.source && typeof doc.source === "object" ? doc.source : {};
  const backup = entries.find((entry) => entry?.kind === "BaseBackup");
  const className = String(totemActor.data.class || "");
  const baseType = baseTypeFromClass(className);
  const buildingIds = entries
    .filter((entry) => entry?.kind === "Building" && entry.data)
    .map((entry) => entry.data.id)
    .filter((id) => id != null);
  const baseId = source.baseId != null && source.baseId !== ""
    ? String(source.baseId)
    : buildingIds.length
      ? String(Math.min(...buildingIds.map(Number)))
      : "";

  const warnings = [];
  const pieceRows = entries
    .filter((entry) => entry?.kind === "BuildingInstance" && entry.data)
    .map((entry) => entry.data)
    .sort((a, b) => Number(a.building_id) - Number(b.building_id) || Number(a.instance_id) - Number(b.instance_id));

  const seenInstanceIds = new Set();
  let remapInstanceIds = false;
  for (const row of pieceRows) {
    const instanceId = Number(row.instance_id);
    if (!Number.isSafeInteger(instanceId) || instanceId < 0 || seenInstanceIds.has(instanceId)) {
      remapInstanceIds = true;
      break;
    }
    seenInstanceIds.add(instanceId);
  }
  if (remapInstanceIds) {
    warnings.push("Some building pieces shared an instance id. They were renumbered so the solido stays unique.");
  }

  let tiltedPieces = 0;
  const instances = pieceRows.map((row, index) => {
    const transform = Array.isArray(row.transform) ? row.transform : [];
    if (Math.abs(Number(transform[3]) || 0) > YAW_ONLY_EPSILON || Math.abs(Number(transform[4]) || 0) > YAW_ONLY_EPSILON) {
      tiltedPieces += 1;
    }
    return {
      instance_id: remapInstanceIds ? index : Number(row.instance_id),
      building_type: String(row.building_type || ""),
      x: (Number(transform[0]) || 0) - Number(anchor.x),
      y: (Number(transform[1]) || 0) - Number(anchor.y),
      z: (Number(transform[2]) || 0) - Number(anchor.z),
      rotation: quaternionYawDegrees(transform[5], transform[6])
    };
  });
  if (tiltedPieces) {
    warnings.push(`${tiltedPieces} building piece${tiltedPieces === 1 ? "" : "s"} ${tiltedPieces === 1 ? "is" : "are"} tilted. A solido image only keeps yaw, the same way the game's blueprint export does.`);
  }

  const placeableRows = entries
    .filter((entry) => entry?.kind === "Placeable" && entry.data && !isClaimPlaceable(entry.data.building_type))
    .map((entry) => entry.data)
    .sort((a, b) => Number(a.id) - Number(b.id));

  let missingActors = 0;
  let tiltedPlaceables = 0;
  const placeables = [];
  for (const row of placeableRows) {
    const actor = byId.get(positiveId(row.id));
    const transform = actor?.kind === "act" ? actor.data?.transform : null;
    if (!transform?.location || !transform.rotation) {
      missingActors += 1;
      continue;
    }
    const rotation = transform.rotation;
    const tilt = Math.abs(Number(rotation.x) || 0) > YAW_ONLY_EPSILON || Math.abs(Number(rotation.y) || 0) > YAW_ONLY_EPSILON;
    let rx = 0;
    let ry = quaternionYawDegrees(rotation.z, rotation.w);
    let rz = 0;
    if (tilt) {
      tiltedPlaceables += 1;
      const euler = quaternionToRotator(rotation.x, rotation.y, rotation.z, rotation.w);
      rx = cleanAngle(euler.pitch);
      ry = cleanAngle(euler.yaw);
      rz = cleanAngle(euler.roll);
    }
    placeables.push({
      placeable_id: String(row.id),
      building_type: String(row.building_type || ""),
      x: Number(transform.location.x) - Number(anchor.x),
      y: Number(transform.location.y) - Number(anchor.y),
      z: Number(transform.location.z) - Number(anchor.z),
      rx,
      ry,
      rz
    });
  }
  if (missingActors) {
    warnings.push(`${missingActors} placeable${missingActors === 1 ? "" : "s"} had no actor location and ${missingActors === 1 ? "was" : "were"} left out.`);
  }
  if (tiltedPlaceables) {
    warnings.push(`${tiltedPlaceables} placeable${tiltedPlaceables === 1 ? "" : "s"} ${tiltedPlaceables === 1 ? "is" : "are"} tilted. Pitch and roll were kept in rx and rz.`);
  }

  const itemCount = entries.filter((entry) => entry?.kind === "itm").length;
  const segmentCount = entries.filter((entry) => entry?.kind === "LandclaimSegment").length;
  const storedPieces = entries.filter((entry) => entry?.kind === "BuildingBlueprintInstance").length;
  const notes = [
    `${instances.length} building piece${instances.length === 1 ? "" : "s"} and ${placeables.length} placeable${placeables.length === 1 ? "" : "s"} kept, measured from the claim console.`,
    "The claim console itself is left out. A solido image must not carry a second Sub-Fief."
  ];
  if (itemCount) {
    notes.push(`${itemCount} stored item${itemCount === 1 ? "" : "s"} stayed behind. A solido image is the layout only.`);
  }
  if (segmentCount) {
    notes.push(`${segmentCount} staking tile${segmentCount === 1 ? "" : "s"} stayed behind. Stake the new fief after you place the solido.`);
  }
  if (storedPieces) {
    notes.push("Solido blueprints stored inside this base were not unpacked. This conversion is the base itself.");
  }
  const scaledShields = countScaledShields(entries, byId);
  if (scaledShields) {
    notes.push(`${scaledShields} pentashield${scaledShields === 1 ? "" : "s"} keep facing, but a live solido image does not record shield size.`);
  }

  const document = {
    base_id: baseId,
    name: source.name || backup?.data?.base_backup_name || "Imported Base",
    base_type: baseType,
    owner_name: source.ownerName || "",
    map: source.map || totemActor.data.map || "",
    x: Number(anchor.x),
    y: Number(anchor.y),
    z: Number(anchor.z),
    piece_count: instances.length,
    placeable_count: placeables.length,
    instances,
    placeables
  };

  return {
    document,
    report: {
      from: "base-backup",
      to: "solido",
      name: document.name,
      map: document.map,
      owner: document.owner_name,
      baseType: document.base_type,
      pieces: instances.length,
      placeables: placeables.length,
      warnings,
      notes
    }
  };
}

export function solidoToBackup(doc, options = {}) {
  const warnings = [];
  const instances = Array.isArray(doc.instances) ? doc.instances : [];
  const rawPlaceables = Array.isArray(doc.placeables) ? doc.placeables : [];
  const placeables = normalizeLegacyPlaceableRotations(rawPlaceables, warnings);
  const kept = [];
  let removedClaims = 0;
  for (const placeable of placeables) {
    if (isClaimPlaceable(placeable?.building_type)) {
      removedClaims += 1;
      continue;
    }
    kept.push(placeable);
  }
  if (removedClaims) {
    warnings.push(`Ignored ${removedClaims} claim console${removedClaims === 1 ? "" : "s"} in the solido. The backup gets one new console of its own.`);
  }
  if (!instances.length && !kept.length) {
    throw new Error("This solido image has no building pieces or placeables to convert.");
  }

  const claim = resolveClaim(doc, options.claim, warnings);
  const advanced = claim === "advanced";
  const totemType = advanced ? "Totem_Placeable" : "Totem_Small_Placeable";
  const totemClass = CLASS_BY_TYPE[totemType];
  const totemHealth = PLACEABLE_HEALTH[totemType];
  const nameInfo = backupName(solidoName(doc), warnings);
  const map = String(doc.map || "HaggaBasin");
  const anchor = {
    x: finiteOr(doc.x, 0),
    y: finiteOr(doc.y, 0),
    z: finiteOr(doc.z, 0)
  };
  if (doc.x == null || doc.y == null || doc.z == null) {
    warnings.push("This solido has no world origin. The claim console is placed at 0, 0, 0 and the pieces keep their spacing.");
  }

  const unknownClasses = new Set();
  const entries = [];
  let nextId = 1;
  const add = (kind, data) => {
    const id = nextId++;
    entries.push({ id, data, kind });
    return id;
  };

  const placeholderId = add("act", {});
  const totemActorId = add("act", actorRecord({
    map,
    className: totemClass,
    serial: 1,
    location: anchor,
    yaw: 0
  }));
  const buildingActorId = add("act", actorRecord({
    map,
    className: BUILDING_ACTOR_CLASS,
    serial: 0,
    location: anchor,
    yaw: 0
  }));

  const placeableActors = [];
  kept.forEach((placeable, index) => {
    const buildingType = requireString(placeable?.building_type, `Placeable ${index + 1} is missing building_type.`);
    const className = classFor(buildingType, unknownClasses);
    const health = placeableHealth(buildingType);
    const yaw = finiteOr(placeable.ry, finiteOr(placeable.rotation, 0));
    const actorId = add("act", actorRecord({
      map,
      className,
      serial: index + 2,
      location: {
        x: anchor.x + finiteCoordinate(placeable.x, `Placeable ${buildingType}`),
        y: anchor.y + finiteCoordinate(placeable.y, `Placeable ${buildingType}`),
        z: anchor.z + finiteCoordinate(placeable.z, `Placeable ${buildingType}`)
      },
      rotation: rotatorToQuaternion(finiteOr(placeable.rx, 0), yaw, finiteOr(placeable.rz, 0)),
      properties: propertiesFor(buildingType, className, health)
    }));
    placeableActors.push({ actorId, buildingType, health, placeable });
  });

  const radius = claimRadius(instances, kept);
  const totemFglId = add("fgl", {
    actor_id: totemActorId,
    slot_name: "Actor",
    components: totemComponents(totemHealth, radius)
  });

  const fillWater = options.fillWater === true;
  for (const item of placeableActors) {
    const slots = slotsFor(item.buildingType, item.health, { fillWater });
    for (const [slotName, components] of Object.entries(slots)) {
      add("fgl", { actor_id: item.actorId, slot_name: slotName, components });
    }
  }

  const inventoryPlans = [
    { actorId: totemActorId, buildingType: totemType },
    ...placeableActors.map((item) => ({ actorId: item.actorId, buildingType: item.buildingType }))
  ];
  for (const plan of inventoryPlans) {
    for (const inventory of INVENTORIES[plan.buildingType] || []) {
      const inventoryId = add("inv", {
        actor_id: plan.actorId,
        inventory_type: inventory.inventory_type,
        max_item_count: inventory.max_item_count,
        max_item_volume: inventory.max_item_volume,
        vehicle_module_id: null
      });
      add("ActorInventory", {
        inventory_id: inventoryId,
        component_name_hash: inventory.component_name_hash
      });
    }
  }

  add("Building", { id: buildingActorId, owner_id: null });

  const seen = new Set();
  let remap = false;
  for (const instance of instances) {
    const instanceId = Number(instance?.instance_id);
    if (!Number.isSafeInteger(instanceId) || instanceId < 0 || seen.has(instanceId)) {
      remap = true;
      break;
    }
    seen.add(instanceId);
  }
  if (remap) warnings.push("Duplicate building-piece ids were renumbered.");

  instances.forEach((instance, index) => {
    const buildingType = requireString(instance?.building_type, `Building piece ${index + 1} is missing building_type.`);
    const yaw = finiteOr(instance.rotation, 0);
    const quat = rotatorToQuaternion(0, yaw, 0);
    add("BuildingInstance", {
      __lb: { transform: 0 },
      health: pieceHealth(buildingType),
      shelter: 255,
      transform: [
        anchor.x + finiteCoordinate(instance.x, buildingType),
        anchor.y + finiteCoordinate(instance.y, buildingType),
        anchor.z + finiteCoordinate(instance.z, buildingType),
        quat.x,
        quat.y,
        quat.z,
        quat.w
      ],
      building_id: buildingActorId,
      instance_id: remap ? index : Number(instance.instance_id),
      sand_buildup: -1,
      building_type: buildingType,
      building_flags: 0,
      owner_entity_id: totemFglId,
      last_placed_by_player_id: 0
    });
  });

  add("Placeable", placeableRecord(totemActorId, totemType, totemHealth, totemFglId));
  for (const item of placeableActors) {
    add("Placeable", placeableRecord(item.actorId, item.buildingType, item.health, totemFglId));
  }

  add("Totem", {
    id: totemActorId,
    __lb: { landclaim_original_global_location: 0 },
    last_backup_timestamp: 0,
    landclaim_vertical_level: advanced ? 5 : 1,
    landclaim_original_global_location: [Math.round(anchor.x), Math.round(anchor.y), Math.round(anchor.z)],
    landclaim_original_global_yaw_rotation: 0
  });

  const backupId = add("BaseBackup", {
    player_id: placeholderId,
    base_backup_name: nameInfo.name,
    last_edited_by_player_id: 0
  });

  const actorIds = entries.filter((entry) => entry.kind === "act" && entry.id !== placeholderId).map((entry) => entry.id);
  for (const actorId of actorIds) {
    add("BaseBackupLinkedActor", { id: backupId, actor_id: actorId });
  }

  if (unknownClasses.size) {
    const sample = [...unknownClasses].slice(0, 4).join(", ");
    warnings.push(`${unknownClasses.size} placeable type${unknownClasses.size === 1 ? "" : "s"} ${unknownClasses.size === 1 ? "has" : "have"} no known Unreal class (${sample}). A best-guess path was used; check those objects after import.`);
  }

  const baseId = doc.base_id != null && doc.base_id !== "" && Number.isFinite(Number(doc.base_id))
    ? Number(doc.base_id)
    : null;

  const document = {
    game: GAME_PROFILE,
    format: "dune-base-backup",
    source: {
      map,
      kind: "converted-solido",
      name: nameInfo.fullName,
      baseId,
      counts: {
        items: 0,
        pieces: instances.length,
        placeables: kept.length + 1
      },
      rawName: nameInfo.fullName,
      backupId: null,
      ownerName: String(doc.owner_name || ""),
      totemType
    },
    console: {
      buildId: "solido-backup-converter",
      version: "pages"
    },
    entries,
    version: 1,
    exportedAt: new Date().toISOString(),
    ownerPlaceholderTransferId: placeholderId
  };

  const notes = [
    `Built a base backup with ${instances.length} building piece${instances.length === 1 ? "" : "s"}, ${kept.length} placeable${kept.length === 1 ? "" : "s"}, and ${advanced ? "an Advanced Sub-Fief" : "a Sub-Fief"} console.`,
    "Chests and crafting stations are empty. A solido image does not record what was stored.",
    waterNote(kept, fillWater),
    "Staking tiles are not part of a solido image. Extend the claim after you place the backup if the base needs more land.",
    "The file is stamped with the game patch from the sample Home Base export. A server on another patch can still import it after you confirm the version warning."
  ].filter(Boolean);

  return {
    document,
    report: {
      from: "solido",
      to: "base-backup",
      name: nameInfo.fullName,
      map,
      owner: String(doc.owner_name || ""),
      baseType: advanced ? "Advanced Sub-Fief" : "Sub-Fief",
      pieces: instances.length,
      placeables: kept.length,
      warnings,
      notes
    }
  };
}

export function suggestFilename(result) {
  const name = fileStem(result.report?.name || "base");
  const owner = fileStem(result.report?.owner || "");
  if (result.format === "solido") {
    const baseId = result.document.base_id ? `_${fileStem(result.document.base_id)}` : "";
    return `${owner || name}_base${baseId}.json`;
  }
  return `${owner ? `${owner}_` : ""}${name}_base-backup_converted.json`;
}

export function validateBackupStructure(doc) {
  const errors = [];
  if (!doc || doc.format !== "dune-base-backup" || !Array.isArray(doc.entries) || !doc.entries.length) {
    return ["File is not a base backup export"];
  }
  const placeholder = positiveId(doc.ownerPlaceholderTransferId);
  if (!placeholder) errors.push("Missing owner placeholder");
  const seen = new Set();
  const counts = {};
  const idsByKind = new Map();
  for (const entry of doc.entries) {
    const id = positiveId(entry?.id);
    if (!id) {
      errors.push("Entry without a valid id");
      continue;
    }
    if (seen.has(id)) errors.push(`Repeated entry id ${id}`);
    seen.add(id);
    if (!ALLOWED_KINDS.has(entry.kind)) errors.push(`Unsupported kind ${entry.kind}`);
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) {
      errors.push(`Entry ${id} has no data`);
      continue;
    }
    counts[entry.kind] = (counts[entry.kind] || 0) + 1;
    if (entry.kind === "act" && id === placeholder) continue;
    if (!idsByKind.has(entry.kind)) idsByKind.set(entry.kind, new Set());
    idsByKind.get(entry.kind).add(id);
  }
  if (!idsByKind.get("act")?.size && counts.act < 2) errors.push("No base actors");
  if (counts.BaseBackup !== 1) errors.push("Expected exactly one backup record");
  if (!counts.Totem) errors.push("No totem");
  const linked = new Set();
  for (const entry of doc.entries) {
    const id = positiveId(entry?.id);
    if (entry?.kind === "act" && id === placeholder) {
      if (Object.keys(entry.data || {}).length) errors.push("Owner placeholder carries data");
      continue;
    }
    for (const [key, rule] of Object.entries(ENTRY_REFS[entry.kind] || {})) {
      const raw = entry.data?.[key];
      const target = rule.replace(/\?$/, "");
      if (target === "absent") {
        if (raw != null) errors.push(`${entry.kind} ${id} sets ${key}`);
        continue;
      }
      if (raw == null) {
        if (!rule.endsWith("?")) errors.push(`${entry.kind} ${id} is missing ${key}`);
        continue;
      }
      const ref = positiveId(raw);
      const isOwner = ref === placeholder;
      const isAct = ref != null && idsByKind.get("act")?.has(ref);
      const ok = target === "owner" ? isOwner
        : target === "actOrOwner" ? isOwner || isAct
          : target === "act" ? isAct
            : ref != null && idsByKind.get(target)?.has(ref);
      if (!ok) errors.push(`${entry.kind} ${id} points ${key} outside the base`);
    }
    if (entry.kind === "BaseBackupLinkedActor") linked.add(positiveId(entry.data.actor_id));
  }
  for (const actorId of idsByKind.get("act") || []) {
    if (!linked.has(actorId)) errors.push(`Actor ${actorId} is not linked to the backup`);
  }
  return errors;
}

export function quaternionYawDegrees(qz, qw) {
  const yaw = (2 * Math.atan2(Number(qz) || 0, Number(qw) || 0)) * (180 / Math.PI);
  return Object.is(yaw, -0) ? 0 : yaw;
}

export function rotatorToQuaternion(pitchDeg, yawDeg, rollDeg) {
  const half = Math.PI / 360;
  const sp = Math.sin(pitchDeg * half);
  const cp = Math.cos(pitchDeg * half);
  const sy = Math.sin(yawDeg * half);
  const cy = Math.cos(yawDeg * half);
  const sr = Math.sin(rollDeg * half);
  const cr = Math.cos(rollDeg * half);
  return {
    x: cr * sp * sy - sr * cp * cy,
    y: -cr * sp * cy - sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
    w: cr * cp * cy + sr * sp * sy
  };
}

export function quaternionToRotator(x, y, z, w) {
  const singularity = z * x - w * y;
  const yawY = 2 * (w * z + x * y);
  const yawX = 1 - 2 * (y * y + z * z);
  const threshold = 0.4999995;
  let pitch;
  let yaw;
  let roll;
  if (singularity < -threshold) {
    pitch = -90;
    yaw = Math.atan2(yawY, yawX) * (180 / Math.PI);
    roll = normalizeAxis(-yaw - 2 * Math.atan2(x, w) * (180 / Math.PI));
  } else if (singularity > threshold) {
    pitch = 90;
    yaw = Math.atan2(yawY, yawX) * (180 / Math.PI);
    roll = normalizeAxis(yaw - 2 * Math.atan2(x, w) * (180 / Math.PI));
  } else {
    pitch = Math.asin(Math.max(-1, Math.min(1, 2 * singularity))) * (180 / Math.PI);
    yaw = Math.atan2(yawY, yawX) * (180 / Math.PI);
    roll = Math.atan2(-2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * (180 / Math.PI);
  }
  return { pitch, yaw, roll };
}

function normalizeAxis(angle) {
  const wrapped = ((angle + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function cleanAngle(angle) {
  if (!Number.isFinite(angle) || Math.abs(angle) < 1e-8) return 0;
  return Object.is(angle, -0) ? 0 : angle;
}

function normalizeLegacyPlaceableRotations(placeables, warnings) {
  const nearZero = (value) => Math.abs(Number(value) || 0) < 0.0001;
  const legacy = placeables.length > 0
    && placeables.every((placeable) => nearZero(placeable?.rx) && nearZero(placeable?.ry))
    && placeables.some((placeable) => !nearZero(placeable?.rz));
  if (!legacy) return placeables;
  warnings.push("Older solido files stored placeable yaw in rz. Those values were moved to ry.");
  return placeables.map((placeable) => ({ ...placeable, ry: placeable.rz ?? 0, rz: 0 }));
}

function isClaimPlaceable(buildingType) {
  return CLAIM_TYPES.has(String(buildingType || "").trim().toLowerCase());
}

function baseTypeFromClass(className) {
  const value = className.toLowerCase();
  if (value.includes("totemsmall") || value.includes("totem_small")) return "Sub-Fief";
  if (value.includes("totem")) return "Advanced Sub-Fief";
  return "Unknown";
}

function resolveClaim(doc, override, warnings) {
  if (override === "small" || override === "advanced") return override;
  const type = String(doc.base_type || "").trim();
  if (/advanced/i.test(type)) return "advanced";
  if (/sub-fief|totem_small/i.test(type)) return "small";
  warnings.push("No claim type was set on the solido. The backup uses an Advanced Sub-Fief console.");
  return "advanced";
}

function solidoName(doc) {
  const raw = doc.name || doc.Name || doc.blueprint_name || "Imported Base";
  return String(raw).replace(/[_.\\]/g, " ").trim().replace(/\s+/g, " ") || "Imported Base";
}

function backupName(fullName, warnings) {
  let name = fullName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.startsWith("##")) name = name.replace(/^#+/, "").trim();
  if (!name) name = "Imported Base";
  if (name.length > BACKUP_NAME_MAX) {
    warnings.push(`Backup names can be ${BACKUP_NAME_MAX} characters. "${name}" was shortened.`);
    name = name.slice(0, BACKUP_NAME_MAX).trim();
  }
  return { fullName, name };
}

function classFor(buildingType, unknown) {
  if (CLASS_BY_TYPE[buildingType]) return CLASS_BY_TYPE[buildingType];
  unknown.add(buildingType);
  const stem = String(buildingType).replace(/_Placeable$/i, "") || "Placeable";
  return `/Game/Dune/Systems/Building/Pieces/BP_${stem}.BP_${stem}_C`;
}

function placeableHealth(buildingType) {
  if (PLACEABLE_HEALTH[buildingType] != null) return PLACEABLE_HEALTH[buildingType];
  if (/light|glow|miniature/i.test(buildingType)) return 500;
  if (/pentashield/i.test(buildingType)) return 3500;
  return 2500;
}

function pieceHealth(buildingType) {
  if (PIECE_HEALTH[buildingType] != null) return PIECE_HEALTH[buildingType];
  if (/foundation|column/i.test(buildingType)) return 10000;
  return 8000;
}

function actorRecord({ map, className, serial, location, yaw = 0, rotation, properties = {} }) {
  const quat = rotation || rotatorToQuaternion(0, yaw, 0);
  return {
    map,
    class: className,
    state: "BaseBackup",
    serial,
    transform: {
      location: { x: location.x, y: location.y, z: location.z },
      rotation: { w: quat.w, x: quat.x, y: quat.y, z: quat.z }
    },
    properties,
    gas_attributes: {},
    dimension_index: 0,
    owner_account_id: null
  };
}

function placeableRecord(actorId, buildingType, health, ownerEntityId) {
  return {
    id: actorId,
    health,
    is_hologram: false,
    building_type: buildingType,
    has_hit_ground: false,
    owner_entity_id: ownerEntityId,
    has_buildable_support: true,
    last_placed_by_player_id: 0
  };
}

const SHELTER_OPEN = [true, true, true, true, true, true, true, true, true];

function healthComponent(current) {
  return [0, {
    m_CurrentHealth: current,
    m_MaxDownButNotOutStateHealth: 0,
    m_CurrentDownButNotOutStateHealth: 0
  }];
}

function shelterComponent() {
  return [0, { m_ShelteredPercentage: 1, m_IsShelteredTraceResults: SHELTER_OPEN.slice() }];
}

function placeableComponent(flag) {
  return [flag, { m_bHasSocketlessConnections: false }];
}

function aggroComponent() {
  return [0, { m_TotalDamageDone: 0 }];
}

function powerComponent() {
  return [4, { m_bForceOff: false, m_bIsEnabled: true, m_ConnectedCircuit: 1 }];
}

function waterCircuit() {
  return [0, { m_bIsEnabled: true, m_ConnectedCircuit: 1 }];
}

function inventoryCircuit() {
  return [0, { m_bIsEnabled: true, m_OutputCircuit: 1, m_ConnectedCircuit: 1 }];
}

function basicComponents(health, placeableFlag, extras = {}) {
  return {
    FHealthComponent: healthComponent(health),
    FShelterComponent: shelterComponent(),
    FPlaceableComponent: placeableComponent(placeableFlag),
    ...extras,
    FAggroControllerComponent: aggroComponent()
  };
}

function totemComponents(health, radius) {
  return {
    ...basicComponents(health, 2, {}),
    FTotemComponent: [0, {}],
    FTotemLandclaimComponent: [0, {
      m_BoundingCircleRadius: radius,
      m_PendingStakingUnitsEntityIds: [],
      m_PendingVerticalStakingUnitsEntityIds: []
    }],
    FPowerCircuitElementComponent: powerComponent(),
    FInventoryCircuitElementComponent: inventoryCircuit()
  };
}

function waterNote(placeables, fillWater) {
  const cisterns = placeables.filter((placeable) => cisternCapacity(placeable?.building_type) != null);
  if (!cisterns.length) {
    return fillWater ? "Fill water cisterns was on, but this solido has no cisterns." : null;
  }
  const total = cisterns.reduce((sum, placeable) => sum + (fillWater ? cisternCapacity(placeable.building_type) : 0), 0);
  if (!fillWater) {
    return `${cisterns.length} water cistern${cisterns.length === 1 ? "" : "s"} left empty. Turn on Fill water cisterns to write them full.`;
  }
  return `${cisterns.length} water cistern${cisterns.length === 1 ? "" : "s"} filled (${groupNumber(total)} water).`;
}

function groupNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function slotsFor(buildingType, health, { fillWater = false } = {}) {
  const inventories = INVENTORIES[buildingType] || [];
  const crafting = inventories.some((inventory) => inventory.inventory_type === 12);
  const powered = /generator|fabricator|refinery|deathstill|recycler|turbine|windtrap|extractor|pentashield|cistern/i.test(buildingType);
  const watery = /cistern|bloodwater|extractor|deathstill/i.test(buildingType);
  const extras = {};
  if (watery) {
    const capacity = cisternCapacity(buildingType);
    extras.FWaterStorageComponent = [0, { m_WaterStored: fillWater && capacity ? capacity : 0 }];
  }
  if (/wind/i.test(buildingType)) {
    extras.FWindShelterComponent = [0, { m_ShelteredPercentage: 0, m_IsShelteredTraceResults: SHELTER_OPEN.map(() => false) }];
  }
  if (powered) extras.FPowerCircuitElementComponent = powerComponent();
  if (watery) extras.FWaterCircuitElementComponent = waterCircuit();
  if (inventories.length) extras.FInventoryCircuitElementComponent = inventoryCircuit();

  if (crafting) {
    const slots = {
      ItemCraftingComponent: {
        FItemCraftingComponent: [0, {
          State: "Idle",
          RequestsQueue: [],
          TargetFarmUpTime: 0,
          NextFreeRequestId: 1,
          TotalTimeToCraftInSec: 0,
          RequestStartUniverseTime: 0,
          PreviouslyCompletedTimeToCraftInSec: 0
        }]
      },
      ItemCraftingStation: basicComponents(health, 16, extras),
      OutcomeInventory: {}
    };
    return slots;
  }

  const slots = { Actor: basicComponents(health, /light|glow|miniature/i.test(buildingType) ? 0 : 16, extras) };
  if (inventories.some((inventory) => inventory.inventory_type === 3 || inventory.inventory_type === 4)) {
    slots.ContainerInventory = {};
  }
  return slots;
}

function propertiesFor(buildingType, className, health) {
  if (!/pentashield/i.test(buildingType)) return {};
  const shortName = className.split(".").pop() || "Pentashield_C";
  return {
    DamageableActorComponent: {
      m_TotalMaxHealth: health,
      m_CurrentMaxHealth: health
    },
    [shortName]: {
      m_bIsSheltered: false,
      m_PersistentScale: { X: 1, Y: 1, Z: 1 },
      m_SandBuildUpColor: 431507,
      m_CurrentSwatchCustomization: "None",
      m_bShouldCreateSandwormThreatBlob: false
    }
  };
}

function claimRadius(instances, placeables) {
  let radius = 8000;
  for (const row of [...instances, ...placeables]) {
    const distance = Math.hypot(finiteOr(row?.x, 0), finiteOr(row?.y, 0));
    if (distance + 2000 > radius) radius = distance + 2000;
  }
  return radius;
}

function countScaledShields(entries, byId) {
  let count = 0;
  for (const entry of entries) {
    if (entry?.kind !== "Placeable" || !/pentashield/i.test(entry.data?.building_type || "")) continue;
    const actor = byId.get(positiveId(entry.data.id));
    const properties = actor?.data?.properties;
    if (!properties || typeof properties !== "object") continue;
    for (const value of Object.values(properties)) {
      const scale = value?.m_PersistentScale;
      if (!scale) continue;
      const parts = [scale.X, scale.Y, scale.Z].map((part) => Number(part) || 0);
      if (parts.some((part) => Math.abs(part - 1) > 0.01)) count += 1;
    }
  }
  return count;
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteCoordinate(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is missing a numeric x, y, or z.`);
  return number;
}

function requireString(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new Error(message);
  return text;
}

function fileStem(value) {
  return String(value || "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
