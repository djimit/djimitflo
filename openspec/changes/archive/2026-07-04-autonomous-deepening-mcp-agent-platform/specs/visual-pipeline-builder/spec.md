## ADDED Requirements

### Requirement: Dashboard has visual pipeline builder
The dashboard MUST provide a drag-and-drop interface for building agent pipelines.

#### Scenario: User can create a pipeline
- **WHEN** the user opens the Pipeline Builder page
- **THEN** they can drag Goal, Loop, Worker, and Checker nodes onto a canvas and connect them

#### Scenario: Pipeline can be exported
- **WHEN** the user finishes building a pipeline
- **THEN** they can export it as an OpenSpec change or trigger it via API
