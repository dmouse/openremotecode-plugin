import { z } from "zod";

// Wire contracts and Dart String.length count UTF-16 code units. Zod >=4.5
// counts code points for string min/max, so keep the existing limits explicit.
export function utf16Length(minimum: number, maximum: number) {
  return z.check<string>((context) => {
    if (context.value.length < minimum) {
      context.issues.push({ code: "too_small", origin: "string", minimum,
        inclusive: true, input: context.value });
    }
    if (context.value.length > maximum) {
      context.issues.push({ code: "too_big", origin: "string", maximum,
        inclusive: true, input: context.value });
    }
  });
}
