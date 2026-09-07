const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^[+()\d][+()\d .-]{5,23}$/
const PLATE = /^[\p{L}\p{N}][\p{L}\p{N} -]{1,14}$/u

export function normalizePlate(value: string) {
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
}

export function validateNewCustomer(details: {
  name: string
  email: string
  phone: string
}) {
  if (!details.name.trim()) return 'Enter the customer’s full name.'
  if (details.email.trim() && !EMAIL.test(details.email.trim())) {
    return 'Enter a valid email address.'
  }
  if (details.phone.trim() && !PHONE.test(details.phone.trim())) {
    return 'Enter a valid phone number.'
  }
  return null
}

export function validatePlate(value: string) {
  const plate = normalizePlate(value)
  if (!plate) return 'Enter a license plate.'
  if (!PLATE.test(plate)) {
    return 'Use 2–15 letters, numbers, spaces, or hyphens for the plate.'
  }
  return null
}
