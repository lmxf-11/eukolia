/**
 * Eukolia substitution for Overleaf's permissions context used by the figure
 * modal (`@/vendor/overleaf/eukolia/permissions`).
 *
 * Overleaf gates file uploads behind project write permission. Eukolia always
 * has write access to the workspace it has open, so this reports the
 * capabilities the editor actually has.
 */
import { createContext, useContext } from 'react'

export interface Permissions {
  read: boolean
  write: boolean
  admin: boolean
  /** Whether new files may be created in the project. */
  createFiles: boolean
}

const defaultPermissions: Permissions = {
  read: true,
  write: true,
  admin: true,
  createFiles: true,
}

export const PermissionsContext = createContext<Permissions>(defaultPermissions)

export const usePermissionsContext = (): Permissions =>
  useContext(PermissionsContext)
