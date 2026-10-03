/**
 * Eukolia substitution for the Overleaf React contexts that the ported figure
 * modal and maths preview reach into (`@/shared/context/*`,
 * `@/features/ide-settings/context/*`, `@/features/ide-react/context/*`).
 *
 * Eukolia's editor is a single document surface, so the handful of values these
 * components need are supplied from one typed context that the host populates
 * from `EukoliaEditorScope`.
 */
import { createContext, useContext } from 'react'

export interface ProjectSettings {
  /** Whether the user allows the editor to compile on demand. */
  compileOnSave?: boolean
  spellCheckEnabled?: boolean
  /** Whether the floating maths preview is enabled (Overleaf's setting). */
  mathPreview?: boolean
  /** Enables or disables the floating maths preview. */
  setMathPreview: (value: boolean) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface EditorContextValue {
  projectId: string | null
  projectName: string | null
  rootFolderPath: string | null
  settings: ProjectSettings
}

const defaultValue: EditorContextValue = {
  projectId: null,
  projectName: null,
  rootFolderPath: null,
  settings: {
    mathPreview: true,
    setMathPreview() {
      /* replaced by ProjectSettingsContext once the host installs settings */
    },
  },
}

export const EditorContext = createContext<EditorContextValue>(defaultValue)

export const useEditorContext = (): EditorContextValue =>
  useContext(EditorContext)

const MATH_PREVIEW_KEY = 'eukolia:visual:mathPreview'

const initialSettings: ProjectSettings = (() => {
  let mathPreview = true
  try {
    const stored = localStorage.getItem(MATH_PREVIEW_KEY)
    if (stored !== null) mathPreview = stored === 'true'
  } catch {
    // storage unavailable; keep the default
  }
  return {
    compileOnSave: true,
    spellCheckEnabled: true,
    mathPreview,
    setMathPreview(value: boolean) {
      this.mathPreview = value
      try {
        localStorage.setItem(MATH_PREVIEW_KEY, String(value))
      } catch {
        // storage unavailable; the in-memory value still applies
      }
    },
  }
})()

export const ProjectSettingsContext =
  createContext<ProjectSettings>(initialSettings)

export const useProjectSettingsContext = (): ProjectSettings =>
  useContext(ProjectSettingsContext)
