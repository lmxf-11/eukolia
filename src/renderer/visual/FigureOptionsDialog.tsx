/**
 * Eukolia figure options dialog.
 * Implements the dialog for editing options of the selected figure — width,
 * caption and label — as minimal source edits.
 *
 * It reads the figure from the ported `editFigureData` state field and applies
 * the user's choices through `figures.ts`, so the widget's edit button does
 * something real rather than dispatching an event nobody handles.
 */

import React, { useMemo, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { editFigureData } from '@/vendor/overleaf/extensions/figure-modal'
import { OLModal, OLModalBody, OLModalFooter, OLModalHeader, OLModalTitle } from '@/vendor/overleaf/eukolia/ol/ol-modal'
import OLButton from '@/vendor/overleaf/eukolia/ol/ol-button'
import OLFormGroup from '@/vendor/overleaf/eukolia/ol/ol-form-group'
import OLFormLabel from '@/vendor/overleaf/eukolia/ol/ol-form-label'
import OLFormControl from '@/vendor/overleaf/eukolia/ol/ol-form-control'
import OLToggleButtonGroup from '@/vendor/overleaf/eukolia/ol/ol-toggle-button-group'
import OLToggleButton from '@/vendor/overleaf/eukolia/ol/ol-toggle-button'
import { useTranslation } from '@/vendor/overleaf/eukolia/i18n'
import {
  computeFigureEdits,
  formatWidth,
  readArgumentText,
  readFigureCapabilities,
} from './figures'
import type { EukoliaEditorScope } from './scope'

export interface FigureOptionsDialogProps {
  view: EditorView | null
  scope: EukoliaEditorScope
  onClose: () => void
}

const WIDTH_CHOICES = [
  { value: '0.25', label: '1/4' },
  { value: '0.5', label: '1/2' },
  { value: '0.75', label: '3/4' },
  { value: '1', label: 'Full width' },
]

export const FigureOptionsDialog: React.FC<FigureOptionsDialogProps> = ({
  view,
  scope,
  onClose,
}) => {
  const { t } = useTranslation()
  const figure = view ? view.state.field(editFigureData, false) : null

  const capabilities = useMemo(
    () => (figure ? readFigureCapabilities(figure) : null),
    [figure]
  )

  const [width, setWidth] = useState<number>(() => figure?.width ?? 0.5)
  const [caption, setCaption] = useState<string>(() =>
    view && figure?.caption ? readArgumentText(view.state, figure.caption) : ''
  )
  const [label, setLabel] = useState<string>(() =>
    view && figure?.label ? readArgumentText(view.state, figure.label) : ''
  )

  if (!view || !figure) return null

  const apply = () => {
    const options: { width?: number; caption?: string; label?: string } = {
      width,
    }
    if (capabilities?.caption) options.caption = caption
    if (capabilities?.label) options.label = label

    const edits = computeFigureEdits(view.state, figure, options)
    if (edits.length > 0) {
      view.dispatch({ changes: edits, userEvent: 'input.figure-options' })
    }
    onClose()
  }

  const filePath =
    figure.file?.path ?? scope.getFilePath() ?? t('unknown_file')

  return (
    <OLModal show onHide={onClose} className="eukolia-figure-dialog">
      <OLModalHeader closeButton onHide={onClose}>
        <OLModalTitle>{t('edit_figure')}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p className="figure-dialog-path">{filePath}</p>

        <OLFormGroup>
          <OLFormLabel id="figure-width-label">
            {t('image_width')}
          </OLFormLabel>
          <OLToggleButtonGroup
            value={width}
            onChange={value => setWidth(Number(value))}
          >
            {WIDTH_CHOICES.map(choice => (
              <OLToggleButton
                key={choice.value}
                value={choice.value}
                checked={width === Number(choice.value)}
                onChange={() => setWidth(Number(choice.value))}
              >
                {choice.label}
              </OLToggleButton>
            ))}
          </OLToggleButtonGroup>
          <p className="figure-dialog-hint">
            {formatWidth(width)} {t('of_the_text_width')}
          </p>
        </OLFormGroup>

        <OLFormGroup>
          <OLFormLabel id="figure-caption-label">
            {t('caption')}
          </OLFormLabel>
          <OLFormControl
            id="figure-caption"
            type="text"
            value={caption}
            disabled={!capabilities?.caption}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setCaption(event.target.value)
            }
          />
        </OLFormGroup>

        <OLFormGroup>
          <OLFormLabel id="figure-label-label">{t('label')}</OLFormLabel>
          <OLFormControl
            id="figure-label"
            type="text"
            value={label}
            disabled={!capabilities?.label}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setLabel(event.target.value)
            }
          />
        </OLFormGroup>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onClose}>
          {t('cancel')}
        </OLButton>
        <OLButton variant="primary" onClick={apply}>
          {t('ok')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}

export default FigureOptionsDialog
