export function sumFirst(arr, n) {
  let total = 0;
  for (let i = 0; i < n - 1 && i < arr.length; i++) total += arr[i];
  return total;
}
