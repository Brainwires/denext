"use client";
// The images in every VM's folder: `qemu-img info`, create, grow, convert, internal snapshots
// (list, create, apply, delete) and delete. Disk changes are refused while the VM runs; apply,
// delete and snapshot delete go through the confirm step.

import { useEffect, useState } from "denext";
import { formatBytes, parseSize } from "../../lib/format.ts";
import type { ImageEntry, ImageInfo } from "../../lib/types.ts";
import { ConfirmButton } from "../confirm.tsx";
import { errorText, hangar } from "../hangar-client.ts";

export function Images() {
  const [images, setImages] = useState<ImageEntry[] | null>(null);
  const [selected, setSelected] = useState<ImageEntry | null>(null);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [message, setMessage] = useState("");

  const load = async () => {
    try {
      setImages(await hangar.images({}));
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  useEffect(() => void load(), []);

  const select = async (img: ImageEntry) => {
    setSelected(img);
    setInfo(null);
    try {
      setInfo(await hangar.imageInfo({ id: img.vmId, file: img.file }));
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const act = async (label: string, what: () => Promise<unknown>) => {
    setMessage(`${label}…`);
    try {
      await what();
      setMessage(`${label}: done`);
    } catch (err) {
      setMessage(errorText(err));
    }
    await load();
    if (selected) await select(selected);
  };

  const vmIds = [...new Set((images ?? []).map((i) => i.vmId))];

  return (
    <section>
      <h1>Images</h1>
      {message && <p className="message">{message}</p>}
      {!images ? <p>Loading…</p> : (
        <table>
          <tbody>
            {images.map((img) => (
              <tr
                key={`${img.vmId}/${img.file}`}
                data-selected={selected?.vmId === img.vmId && selected.file === img.file}
                onClick={() => void select(img)}
              >
                <td>{img.vmId}</td>
                <td>{img.file}</td>
                <td>{img.kind}</td>
                <td>{formatBytes(img.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && <ImageDetail image={selected} info={info} act={act} />}
      <CreateImage vmIds={vmIds} act={act} />
    </section>
  );
}

function ImageDetail(props: {
  image: ImageEntry;
  info: ImageInfo | null;
  act: (label: string, what: () => Promise<unknown>) => Promise<void>;
}) {
  const { image, info, act } = props;
  const [size, setSize] = useState("");
  const [target, setTarget] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const id = image.vmId;
  const file = image.file;
  const disk = image.kind === "disk";
  return (
    <div className="detail">
      <h2>{id} / {file}</h2>
      {info && (
        <p>
          {info.format} · {formatBytes(info.virtualBytes)} virtual · {formatBytes(info.actualBytes)}
          {" "}
          on disk
          {info.backingFile && ` · backed by ${info.backingFile}`}
        </p>
      )}
      {disk && (
        <>
          <p className="row">
            <input
              placeholder="New size, e.g. 200G"
              value={size}
              onInput={(e) => setSize((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              disabled={!parseSize(size)}
              onClick={() =>
                act("Resize", () => hangar.resizeImage({ id, file, size: parseSize(size)! }))}
            >
              Grow
            </button>
          </p>
          <p className="row">
            <input
              placeholder="copy.qcow2"
              value={target}
              onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              disabled={!target}
              onClick={() =>
                act("Convert", () =>
                  hangar.convertImage({
                    id,
                    file,
                    target,
                    format: target.endsWith(".qcow2") ? "qcow2" : "raw",
                  }))}
            >
              Convert
            </button>
          </p>
          <h3>Snapshots</h3>
          <ul>
            {(info?.snapshots ?? []).map((s) => (
              <li key={s.id} className="row">
                <span>
                  {s.name} · {new Date(s.date * 1000).toLocaleString()}
                  {s.vmStateBytes > 0 && ` · ${formatBytes(s.vmStateBytes)} VM state`}
                </span>
                <ConfirmButton
                  label="Apply"
                  expected={s.name}
                  onConfirm={(confirm) =>
                    act("Apply", () =>
                      hangar.snapshot({ id, file, action: "apply", name: s.name, confirm }))}
                />
                <ConfirmButton
                  label="Delete"
                  expected={s.name}
                  onConfirm={(confirm) =>
                    act("Delete snapshot", () =>
                      hangar.snapshot({ id, file, action: "delete", name: s.name, confirm }))}
                />
              </li>
            ))}
            {info?.snapshots.length === 0 && <li>None.</li>}
          </ul>
          <p className="row">
            <input
              placeholder="snapshot name"
              value={snapshot}
              onInput={(e) =>
                setSnapshot((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              disabled={!snapshot}
              onClick={() =>
                act("Snapshot", () =>
                  hangar.snapshot({ id, file, action: "create", name: snapshot }))}
            >
              Take snapshot
            </button>
          </p>
        </>
      )}
      <p className="row">
        <ConfirmButton
          label="Delete image"
          expected={file}
          onConfirm={(confirm) =>
            act("Delete", () =>
              hangar.deleteImage({ id, file, confirm }))}
        />
      </p>
    </div>
  );
}

function CreateImage(props: {
  vmIds: string[];
  act: (label: string, what: () => Promise<unknown>) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [file, setFile] = useState("data.qcow2");
  const [size, setSize] = useState("20G");
  const vm = id || props.vmIds[0] || "";
  return (
    <div className="detail">
      <h2>New image</h2>
      <p className="row">
        <select value={vm} onChange={(e) => setId((e.target as HTMLSelectElement).value)}>
          {props.vmIds.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <input value={file} onInput={(e) => setFile((e.target as HTMLInputElement).value)} />
        <input value={size} onInput={(e) => setSize((e.target as HTMLInputElement).value)} />
        <button
          type="button"
          disabled={!vm || !parseSize(size)}
          onClick={() =>
            props.act("Create", () =>
              hangar.createImage({
                id: vm,
                file,
                size: parseSize(size)!,
                format: file.endsWith(".qcow2") ? "qcow2" : "raw",
              }))}
        >
          Create
        </button>
      </p>
    </div>
  );
}
