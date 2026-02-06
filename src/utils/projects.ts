// Project data configuration file
// Used to manage data for the project display page

// 1. 修改这里：加上 ** 以支持子文件夹递归
const projectModules = import.meta.glob('../content/projects/**/*.json', { eager: true });

export interface Project {
    id: string;
    title: string;
    description: string;
    image: string;
    category: "library" | "ai" | "software" | "website" | "game" | "hardware"; // 我保留了你需要的 hardware
    techStack: string[];
    status: "completed" | "in-progress" | "planned";
    demoUrl?: string;
    sourceUrl?: string;
    startDate: string;
    endDate?: string;
    featured?: boolean;
    tags?: string[];
    basePath?: string; // 2. 新增这个字段
}

export const projectsData: Project[] = Object.entries(projectModules).map(([path, mod]: [string, any]) => {
    const id = path.split('/').pop()?.replace('.json', '') || '';
    const data = mod.default as any;
    
    // 3. 核心逻辑：计算当前 json 所在的目录路径
    const basePath = path.replace('../', '').replace(/\/[^/]+$/, '');

    const project: Project = {
        id,
        ...data,
        demoUrl: data.demoUrl ?? data.liveDemo,
        sourceUrl: data.sourceUrl ?? data.sourceCode,
        basePath, // 4. 把路径传出去
    };
    return project;
});

// ... 下面的统计函数保持不变 ...
export const getProjectStats = () => {
    const total = projectsData.length;
    const completed = projectsData.filter((p) => p.status === "completed").length;
    const inProgress = projectsData.filter((p) => p.status === "in-progress").length;
    const planned = projectsData.filter((p) => p.status === "planned").length;
    return { total, byStatus: { completed, inProgress, planned } };
};

export const getProjectsByCategory = (category?: string) => {
    if (!category || category === "all") return projectsData;
    return projectsData.filter((p) => p.category === category);
};

export const getFeaturedProjects = () => {
    return projectsData.filter((p) => p.featured);
};

export const getAllTechStack = () => {
    const techSet = new Set<string>();
    projectsData.forEach((project) => {
        project.techStack.forEach((tech) => techSet.add(tech));
    });
    return Array.from(techSet).sort();
};