import { convertDocument, detectFormat, suggestFilename } from "./converter.js";

const fileInput = document.querySelector("#file");
const drop = document.querySelector("#drop");
const fileName = document.querySelector("#file-name");
const solidoOptions = document.querySelector("#solido-options");
const claimSelect = document.querySelector("#claim");
const fillWater = document.querySelector("#fill-water");
const status = document.querySelector("#status");
const direction = document.querySelector("#direction");
const stats = document.querySelector("#stats");
const messages = document.querySelector("#messages");
const download = document.querySelector("#download");
const preview = document.querySelector("#preview");
const trySample = document.querySelector("#try-sample");

let sourceText = "";
let sourceLabel = "";
let result = null;

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) readFile(file);
});

drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("hot");
});

drop.addEventListener("dragleave", () => drop.classList.remove("hot"));

drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("hot");
  const file = event.dataTransfer?.files?.[0];
  if (file) readFile(file);
});

claimSelect.addEventListener("change", () => {
  if (sourceText) convertText(sourceText);
});

fillWater.addEventListener("change", () => {
  if (sourceText) convertText(sourceText);
});

download.addEventListener("click", () => {
  if (!result) return;
  const blob = new Blob([JSON.stringify(result.document, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestFilename(result);
  link.click();
  URL.revokeObjectURL(url);
});

trySample.addEventListener("click", async () => {
  status.textContent = "";
  status.classList.remove("error");
  try {
    const response = await fetch("./fixtures/mini-solido.json");
    if (!response.ok) throw new Error("The example file could not be loaded.");
    sourceLabel = "mini-solido.json";
    sourceText = await response.text();
    fileName.hidden = false;
    fileName.textContent = sourceLabel;
    convertText(sourceText);
  } catch (error) {
    fail(error.message || "The example file could not be loaded.");
  }
});

function readFile(file) {
  sourceLabel = file.name;
  fileName.hidden = false;
  fileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    sourceText = String(reader.result || "");
    convertText(sourceText);
  };
  reader.onerror = () => fail("That file could not be read.");
  reader.readAsText(file);
}

function convertText(text) {
  status.textContent = "";
  status.classList.remove("error");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("That file is not valid JSON.");
    return;
  }
  const detected = detectFormat(parsed);
  solidoOptions.hidden = detected !== "solido";
  try {
    const claim = claimSelect.value === "auto" ? undefined : claimSelect.value;
    result = convertDocument(parsed, { claim, fillWater: detected === "solido" && fillWater.checked });
  } catch (error) {
    fail(error.message || "This file could not be converted.");
    return;
  }
  render(result);
}

function render(conversion) {
  const report = conversion.report;
  direction.textContent = report.from === "solido"
    ? "Solido image → base backup"
    : "Base backup → solido image";
  stats.hidden = false;
  document.querySelector("#stat-name").textContent = report.name || "—";
  document.querySelector("#stat-map").textContent = report.map || "—";
  document.querySelector("#stat-owner").textContent = report.owner || "—";
  document.querySelector("#stat-type").textContent = report.baseType || "—";
  document.querySelector("#stat-pieces").textContent = String(report.pieces);
  document.querySelector("#stat-placeables").textContent = String(report.placeables);
  messages.replaceChildren();
  for (const note of report.notes) messages.append(paragraph("note", note));
  for (const warning of report.warnings) messages.append(paragraph("warning", warning));
  download.disabled = false;
  download.textContent = conversion.format === "solido" ? "Download solido JSON" : "Download base backup JSON";
  const pretty = JSON.stringify(conversion.document, null, 2);
  preview.hidden = false;
  preview.textContent = pretty.length > 4000 ? `${pretty.slice(0, 4000)}\n…` : pretty;
  status.textContent = sourceLabel ? `Converted ${sourceLabel}.` : "Converted.";
}

function paragraph(className, text) {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function fail(message) {
  result = null;
  download.disabled = true;
  stats.hidden = true;
  preview.hidden = true;
  messages.replaceChildren();
  direction.textContent = "Could not convert";
  status.classList.add("error");
  status.textContent = message;
}
