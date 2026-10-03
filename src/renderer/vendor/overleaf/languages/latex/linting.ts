import { latexLinter } from './linter/latex-linter'
import { lintSourceConfig } from '@/vendor/overleaf/extensions/annotations'
import { createLinter } from '../../extensions/linting'

export const linting = () => createLinter(latexLinter, lintSourceConfig)
