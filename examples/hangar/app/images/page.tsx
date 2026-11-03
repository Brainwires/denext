import { Images } from "./images.tsx";
import { windowTitle } from "../../lib/tray.ts";

// The page's title is its window's title (the system WebView keeps them in step).
export const metadata = { title: windowTitle("/images") };

export default function ImagesPage() {
  return <Images />;
}
