// The markup every route injects. `<br/>` and the bare `value` re-serialize differently
// (`<br>`, `value=""`), so a raw string comparison would wrongly read them as a mismatch.
export const RAW = '<b id="b">hi</b><br/><i>there</i><input id="in" value>';
