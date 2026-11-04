export function hasVisibleNote(value: string) {
  return /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]/u.test(value);
}
