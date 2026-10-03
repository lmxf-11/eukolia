import { FC } from 'react'
import { useTranslation } from '@/vendor/overleaf/eukolia/i18n'
import { useIncludedFile } from '@/vendor/overleaf/hooks/use-included-file'
import OLButton from '@/vendor/overleaf/eukolia/ol/ol-button'
import MaterialIcon from '@/vendor/overleaf/eukolia/material-icon'

export const InputTooltipContent: FC = () => {
  const { t } = useTranslation()
  const { openIncludedFile } = useIncludedFile('InputArgument')

  return (
    <div className="ol-cm-command-tooltip-content">
      <OLButton
        variant="link"
        type="button"
        className="ol-cm-command-tooltip-link"
        onClick={openIncludedFile}
      >
        <MaterialIcon type="edit" />
        {t('open_file')}
      </OLButton>
    </div>
  )
}
