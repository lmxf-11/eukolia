/**
 * Eukolia icon set.
 *
 * Every icon the UI uses is re-exported from here so the rest of the shell
 * imports icons from one place. That keeps the visual language consistent, makes
 * the icon dependency explicit, and means swapping the icon library later only
 * touches this file.
 *
 * Only icons that are actually rendered by `ui/components/*` are listed — an
 * unused re-export would be dead weight in the bundle.
 */

export {
  ArrowLeft,
  ChevronUp,
  ZoomOut,
  ArrowRight,
  // Build / diagnostics status
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Info,
  TriangleAlert,
  // Explorer header and tree
  ChevronsDownUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  // Outline and symbols
  AtSign,
  Boxes,
  Braces,
  Library,
  ListTree,
  Quote,
  Radical,
  Sigma,
  SquareFunction,
  Star,
  StarOff,
  Tag,
  // Search
  CaseSensitive,
  Filter,
  Regex,
  ReplaceAll,
  Search,
  WholeWord,
  // Tabs and panels
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  X,
  // Palette, quick open, settings
  CornerDownLeft,
  Keyboard,
  LoaderCircle,
  Moon,
  Sun,
  // Snippets
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  GripVertical,
  RotateCw,
  Save,
  Wand2,
  Zap,
  // Terminal
  TerminalSquare,
  Trash2,
  // Title bar: layout toggles and window controls
  LayoutPanelLeft,
  LayoutPanelTop,
  PanelBottom,
  PanelLeft,
  Maximize2,
  Minimize2,
  ZoomIn,
  // Tab bar toolbar: compile, viewer, modes and chrome toggles
  Play,
  Square,
  Eye,
  EyeOff,
  Code,
  Type,
  Focus,
  Menu,
  // Activity bar
  Settings,
  // File type icons for tabs and explorer
  BookMarked,
  Code2,
  FileArchive,
  FileBox,
  FileClock,
  FileCode2,
  FileJson,
  FileSliders,
  FileSpreadsheet,
  Globe,
  Image,
  Layers,
  Palette,
  Terminal
} from 'lucide-react';

export type { LucideIcon, LucideProps } from 'lucide-react';
