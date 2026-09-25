// Files and media: the app's file storage, the camera / photo picker, the document picker,
// the barcode scanner and SQLite.
import { useState } from "denext";
import {
  downloadToFile,
  listDir,
  openSqlite,
  pickDocument,
  type PickedImage,
  pickImage,
  readFile,
  scanBarcode,
  type SqliteDatabase,
  writeFile,
} from "denext/mobile";
import { Button, Output, Section, useRun } from "../ui.tsx";

function Filesystem() {
  const [out, run] = useRun();
  const write = () =>
    writeFile("notes/hello.txt", `Written at ${new Date().toISOString()}`, {
      recursive: true,
    })
      .then(() => "wrote notes/hello.txt");
  const download = async () => {
    const { path } = await downloadToFile(
      "https://example.com/",
      "downloads/example.html",
    );
    const html = await readFile("downloads/example.html");
    return { path, bytes: html.length };
  };
  return (
    <Section
      title="Filesystem"
      note='App storage ("data") natively, the Origin Private File System on the web.'
    >
      <div class="row">
        <Button label="Write" onClick={() => run(write)} />
        <Button
          label="Read"
          onClick={() => run(() => readFile("notes/hello.txt"))}
        />
        <Button
          label="List notes/"
          onClick={() => run(() => listDir("notes"))}
        />
        <Button label="Download example.com" onClick={() => run(download)} />
      </div>
      <Output value={out} />
    </Section>
  );
}

function Pickers() {
  const [image, setImage] = useState<PickedImage | null>(null);
  const [out, run] = useRun();
  const pick = (source: "camera" | "photos") =>
    run(async () => {
      const picked = await pickImage({ source });
      setImage(picked);
      return picked ?? "cancelled";
    });
  const doc = () =>
    run(async () => {
      const file = await pickDocument();
      return file ? { name: file.name, mimeType: file.mimeType, size: file.size } : "cancelled";
    });
  return (
    <Section
      title="Camera, photos and documents"
      note="Each picker resolves null when cancelled."
    >
      <div class="row">
        <Button label="Take a photo" onClick={() => pick("camera")} />
        <Button label="Choose a photo" onClick={() => pick("photos")} />
        <Button label="Pick a document" onClick={doc} />
      </div>
      {image?.webPath && <img class="preview" src={image.webPath} alt="The picked image" />}
      <Output value={out} />
    </Section>
  );
}

function Barcode() {
  const [out, run] = useRun();
  return (
    <Section
      title="Barcode scanner"
      note="The native scanner; BarcodeDetector over the camera on the web."
    >
      <Button
        label="Scan"
        onClick={() => run(async () => (await scanBarcode()) ?? "cancelled")}
      />
      <Output value={out} />
    </Section>
  );
}

let db: Promise<SqliteDatabase> | undefined;
/** One connection for the page: the native plugin's file, else OPFS (or memory) in the browser. */
function database(): Promise<SqliteDatabase> {
  db ??= openSqlite("kitchen-sink").then(async (conn) => {
    await conn.exec(
      "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT, at TEXT)",
    );
    return conn;
  });
  return db;
}

function Sqlite() {
  const [out, run] = useRun();
  const insert = async () => {
    const conn = await database();
    return conn.run("INSERT INTO notes (text, at) VALUES (?, ?)", [
      "hello",
      new Date().toISOString(),
    ]);
  };
  const select = async () => {
    const conn = await database();
    return {
      backend: conn.backend,
      rows: await conn.query("SELECT * FROM notes ORDER BY id DESC LIMIT 5"),
    };
  };
  return (
    <Section
      title="SQLite"
      note="openSqlite(name): creates the table on first use."
    >
      <div class="row">
        <Button label="Insert a row" onClick={() => run(insert)} />
        <Button label="Select" onClick={() => run(select)} />
      </div>
      <Output value={out} />
    </Section>
  );
}

export function Files() {
  return (
    <>
      <Filesystem />
      <Pickers />
      <Barcode />
      <Sqlite />
    </>
  );
}
