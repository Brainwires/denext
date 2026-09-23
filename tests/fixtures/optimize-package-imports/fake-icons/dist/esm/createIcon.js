export default function createIcon(name) {
  return function Icon() {
    return "ICON:" + name;
  };
}
