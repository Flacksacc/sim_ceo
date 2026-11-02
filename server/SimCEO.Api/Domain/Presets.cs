namespace SimCEO.Api.Domain;

public sealed record Preset(
  string Key, string Title, string[] Roles,
  string Question, string Agenda, string Deliverable);

public static class PresetLibrary
{
  public static readonly IReadOnlyList<Preset> All = new List<Preset>
  {
    new("strategy", "Strategy", new[] { "Strategist", "Operator", "Customer advocate", "Skeptic" },
      "What decision would make the biggest difference to this board's goal?",
      "Define goal; compare options; test risks.", "Options and tradeoffs."),
    new("product", "Product", new[] { "Product lead", "User researcher", "Engineer", "Go-to-market advisor" },
      "Who is this for, and what problem should we validate first?",
      "Define user and problem; challenge assumptions; choose a test.", "Product priorities and next validation step."),
    new("operations", "Operations", new[] { "Process lead", "Finance reviewer", "People advisor", "Risk reviewer" },
      "Where is work slowing down or producing avoidable errors?",
      "Map the bottleneck; weigh fixes; choose measures.", "Improvement plan and owners to confirm."),
    new("career", "Career Change", new[] { "Recruiter", "Field practitioner", "Skills coach", "Skeptic" },
      "Which next role fits my goals and current experience?",
      "Compare roles; identify gaps; choose first steps.", "Transition plan and skill-gap list."),
    new("learning", "Learning & Education", new[] { "Teacher", "Subject expert", "Study coach", "Career advisor" },
      "What should I learn first to reach my goal?",
      "Define outcome; sequence topics; set a study rhythm.", "Learning path and weekly plan."),
    new("family", "Family Decisions", new[] { "Family organizer", "Budget planner", "Logistics advisor", "Mediator" },
      "What decision does our family need to make, and what matters to everyone involved?",
      "Gather priorities; compare options; identify conversations needed.", "Tradeoff map and shared action list."),
    new("caregiving", "Caregiving", new[] { "Care coordinator", "Patient advocate", "Benefits navigator", "Logistics planner" },
      "What care tasks and questions need attention first?",
      "Map people and appointments; list unknowns; assign follow-ups.", "Appointment questions and coordination plan."),
    new("home", "Home Project", new[] { "Designer", "Contractor", "Budget reviewer", "Maintenance advisor" },
      "What is the smallest useful scope for this project?",
      "Define needs; phase the work; identify cost and maintenance risks.", "Phased scope and budget questions."),
    new("smallbiz", "Small Business", new[] { "Operator", "Customer advocate", "Marketer", "Financial planner" },
      "What should this business prove in the next 90 days?",
      "Define customer and offer; test economics; set milestones.", "Practical 90-day plan."),
    new("creative", "Creative Project", new[] { "Creative director", "Producer", "Audience researcher", "Rights advisor" },
      "What should this project make, and who is it for?",
      "Shape concept; identify audience; plan production and rights.", "Concept brief and production roadmap."),
    new("nonprofit", "Community or Nonprofit", new[] { "Community representative", "Program designer", "Fundraiser", "Operations lead" },
      "What community outcome should we work toward first?",
      "Define need; map stakeholders; choose a measurable pilot.", "Impact plan and stakeholder map."),
    new("relocation", "Travel or Relocation", new[] { "Local researcher", "Logistics planner", "Budget advisor", "Accessibility advisor" },
      "Which destination best fits my priorities and constraints?",
      "Compare places; check costs and access; plan logistics.", "Destination comparison and logistics plan."),
    new("retirement", "Retirement & Next Chapter", new[] { "Lifestyle planner", "Financial questions advisor", "Community connector", "Skeptic" },
      "What do I want my next chapter to make room for?",
      "Explore priorities; compare scenarios; list decisions to research.", "Scenarios for time, work, and priorities."),
    new("blank", "Blank", new string[0],
      "What should this board help decide first?",
      "Define goal; list constraints; choose a first question.", "Framed goal and first question."),
  };

  public static Preset? Find(string key) =>
    All.FirstOrDefault(p => string.Equals(p.Key, key, StringComparison.OrdinalIgnoreCase));
}
