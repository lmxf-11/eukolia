export interface ProjectLibraryStatus {
  root: string | null;
  configuredRoot: string | null;
  error?: string;
  templates: string[];
  inputs: string[];
  hasMacros: boolean;
  projects: Array<{ name: string; path: string }>;
}

export interface CreateLibraryProject {
  name: string;
  template: string;
  copyMacros: boolean;
  inputs: string[];
}

export interface CreatedLibraryProject {
  directory: string;
  mainFile: string;
}
