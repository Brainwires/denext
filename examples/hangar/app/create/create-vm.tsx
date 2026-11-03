"use client";
// A new VM: architecture, accelerator, CPUs, memory, one disk, an optional installer ISO to boot
// from once, forwarded ports and the display. Saved as `hangar.json` in a new library folder; the
// backend validates every field again (lib/vm-config.ts).

import { useRouter, useState } from "denext";
import { parseSize } from "../../lib/format.ts";
import type { HangarVmConfig } from "../../lib/vm-config.ts";
import { errorText, hangar } from "../hangar-client.ts";

/** `2222:22, 3390:3389` → forwards. */
function parseForwards(text: string) {
  return text.split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [hostPort, guestPort] = pair.split(":").map(Number);
    return { proto: "tcp" as const, hostAddress: "127.0.0.1", hostPort, guestPort };
  });
}

export function CreateVm() {
  const router = useRouter();
  const [form, setForm] = useState({
    id: "",
    name: "",
    arch: "aarch64" as HangarVmConfig["arch"],
    accel: "hvf" as HangarVmConfig["accel"],
    cpus: 4,
    memoryGiB: 4,
    diskSize: "40G",
    iso: "",
    forwards: "2222:22",
    display: "cocoa" as HangarVmConfig["display"],
  });
  const [message, setMessage] = useState("");
  const set = (key: keyof typeof form) => (e: { target: unknown }) => {
    const el = e.target as HTMLInputElement;
    setForm({ ...form, [key]: el.type === "number" ? Number(el.value) : el.value });
  };

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setMessage("Creating…");
    try {
      const config: HangarVmConfig = {
        version: 1,
        name: form.name || form.id,
        arch: form.arch,
        accel: form.accel,
        cpus: form.cpus,
        memoryMiB: Math.round(form.memoryGiB * 1024),
        disks: [{ file: "disk.qcow2", interface: "virtio" }],
        iso: form.iso || null,
        nics: [{ model: "virtio-net-pci", forwards: parseForwards(form.forwards) }],
        display: form.display,
      };
      const vm = await hangar.createVm({
        id: form.id,
        config,
        diskSize: parseSize(form.diskSize) ?? form.diskSize,
      });
      router.push(`/vm?id=${encodeURIComponent(vm.id)}`);
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <h1>New VM</h1>
      <label>
        Folder name{" "}
        <input required pattern="[a-z0-9][a-z0-9._\-]*" value={form.id} onInput={set("id")} />
      </label>
      <label>
        Display name <input value={form.name} onInput={set("name")} />
      </label>
      <label>
        Architecture
        <select value={form.arch} onChange={set("arch")}>
          <option value="aarch64">aarch64</option>
          <option value="x86_64">x86_64</option>
        </select>
      </label>
      <label>
        Accelerator
        <select value={form.accel} onChange={set("accel")}>
          <option value="hvf">hvf (Apple silicon, aarch64 only)</option>
          <option value="tcg">tcg (emulated)</option>
        </select>
      </label>
      <label>
        CPUs <input type="number" min={1} max={64} value={form.cpus} onInput={set("cpus")} />
      </label>
      <label>
        Memory (GiB){" "}
        <input type="number" min={1} max={1024} value={form.memoryGiB} onInput={set("memoryGiB")} />
      </label>
      <label>
        Disk size <input value={form.diskSize} onInput={set("diskSize")} />
      </label>
      <label>
        Boot from ISO (absolute path, optional){" "}
        <input
          placeholder="/Users/me/Downloads/installer.iso"
          value={form.iso}
          onInput={set("iso")}
        />
      </label>
      <label>
        Forwarded ports (host:guest, …) <input value={form.forwards} onInput={set("forwards")} />
      </label>
      <label>
        Display
        <select value={form.display} onChange={set("display")}>
          <option value="cocoa">window (cocoa)</option>
          <option value="none">none (always headless)</option>
        </select>
      </label>
      <button type="submit">Create</button>
      {message && <p className="message">{message}</p>}
    </form>
  );
}
