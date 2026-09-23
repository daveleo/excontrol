import { useEffect, useState } from "react";

/** True on phone-width screens — cards start collapsed there. */
export function useNarrow(query = "(max-width: 640px)"): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return narrow;
}
