import type { CmsArticleBody } from "./route-page-contract";

/** Original product guides. Staging creates drafts only; publication remains a
 * canonical CMS review action. No person, testimonial or media ownership is invented. */
export const editorialContent: readonly {
  path: string; title: string; description: string; body: CmsArticleBody;
}[] = [
  {
    path: "/images", title: "Character images: create, edit and keep",
    description: "Practical iDream image guides for choosing a character, preserving visual identity, editing a source and keeping the results you want.",
    body: { heading: "Character images", intro: "An image works best when you can explain who is in it, what should happen and what must stay recognizable. These guides help you use iDream's existing image tools without losing the character or the original source.", sections: [
      { heading: "Start with a recognizable character", paragraphs: ["Choose a Character in Generate when the image should belong to an established companion. Freeplay is useful for independent concepts. In a Character request, keep the stable face and appearance separate from the moment: pose, clothes, setting, lighting and camera."] },
      { heading: "Build from a result you like", paragraphs: ["Use an existing image as the source for an edit when you want a specific change. Review the result before saving it, choosing it as a main image or making a collection public. Saving an image to your own library does not require sharing it with other people."] },
    ], cta: { label: "Open image generation", href: "/generate" } },
  },
  {
    path: "/images/character-identity", title: "Keep a character recognizable in a new scene",
    description: "A concrete guide to describing a new moment while keeping the same character's face, appearance and visual references in iDream.",
    body: { heading: "Keep the character, change the moment", intro: "A new outfit or setting should feel like another moment with the same companion. Treat identity as the stable foundation and the scene as a deliberate change. This makes both your prompt and your review more specific.", sections: [
      { heading: "Name the change clearly", paragraphs: ["Begin with the action and location: a character reading beside a rainy window, looking back on a quiet street, or resting after a long day. Add the camera and light only when they matter. Avoid redefining their face or physical features when those should remain the same."] },
      { heading: "Choose the reference for the task", paragraphs: ["A Character request uses the visual identity associated with that Character. A Look can describe a particular appearance or outfit. A source edit begins with the selected image. These inputs have different jobs; an unrelated image is not a reliable substitute for the character you meant to preserve."] },
      { heading: "Review before adopting the result", paragraphs: ["Compare the face, hairstyle and distinctive features with the original. Check hands, eyes and the intended action at full size. A technically delivered image can still need another attempt. Keep the result you prefer, and use it as the main image only when it represents the Character you want."] },
    ], cta: { label: "Describe a character moment", href: "/generate" } },
  },
  {
    path: "/images/edit-a-source", title: "Edit a source image with a precise brief",
    description: "Use a specific source and an accepted edit brief to change clothing, lighting or a background while checking the parts you meant to retain.",
    body: { heading: "Make one deliberate image edit", intro: "An edit is easier to judge when its brief names the change and the details that should stay. Begin with an image you are allowed to use, then make the smallest clear change that moves it toward your intended result.", sections: [
      { heading: "Say what changes and what stays", paragraphs: ["For example: change the jacket to a dark blue coat while keeping the face, hairstyle, pose and room. If the background should change, name the new setting and the lighting you expect. A short, specific brief is more useful than asking to improve everything at once."] },
      { heading: "Check the accepted source and price", paragraphs: ["Before submitting, verify the source preview and the quoted cost. If you select a different source or change the edit, review the new request. When a connection drops after submission, check the original job before creating another request; the first one may still be running."] },
      { heading: "Compare the delivered pixels", paragraphs: ["Open the original and edited result at useful sizes. Check that the requested change happened and that the retained details remain recognizable. Enhance can increase output dimensions, but a larger file is not a guarantee that an incorrect face, pose or edit has been fixed."] },
    ], cta: { label: "Open your source images", href: "/custom" } },
  },
  {
    path: "/videos", title: "Character video: plan motion and review a clip",
    description: "Read practical iDream video guides for choosing a source, describing motion, checking the accepted specifications and keeping a delivered clip.",
    body: { heading: "Character video guides", intro: "A character video begins with a source image and a motion brief. The source establishes the visible person and composition; the brief explains how the moment should move. Review the available specifications before starting a job.", sections: [
      { heading: "Use the available video route", paragraphs: ["Video generation is available for eligible Characters with a usable source image and the required account access. The options and price shown before submission describe the request that will run. Freeplay image generation does not automatically provide a character video source."] },
      { heading: "Keep the brief easy to review", paragraphs: ["Describe a clear action, camera movement and mood. After delivery, watch the entire clip, including its first and last frames, and listen when it contains audio. Check the character's identity and the intended motion before downloading or sharing the result."] },
    ], cta: { label: "Open character generation", href: "/generate" } },
  },
  {
    path: "/videos/animate-a-character", title: "Animate a character from a clear source image",
    description: "Plan an iDream character clip with a source image, a concise motion brief, a reviewed quote and a full playback check after delivery.",
    body: { heading: "Plan a character clip you can judge", intro: "A useful video brief describes a moment that can be recognized on playback. Choose a source with the character clearly visible, then describe what changes over time. Treat the quoted specifications and the generated result as separate things to review.", sections: [
      { heading: "Choose an image that supports the action", paragraphs: ["Check the face, body position and framing in the source. If you want a small gesture, a clear portrait can be enough. If the action needs more of the body or surroundings, start with a suitable composition rather than expecting the clip to invent unseen details consistently."] },
      { heading: "Write motion rather than a second portrait", paragraphs: ["Describe what the character does and how the camera behaves: turns toward the window, gives a small wave, or looks up while the camera remains still. Avoid stacking incompatible actions into one short scene. Keep stable appearance details consistent with the source."] },
      { heading: "Review specifications and recover the original job", paragraphs: ["Check the available duration, dimensions, sound option and total cost before accepting a request. Generation can take time. If the page or network disconnects, return to Jobs and check the accepted request. Repeated clicks should not be used as a substitute for checking whether a clip was delivered."] },
      { heading: "Watch and listen before keeping it", paragraphs: ["Watch the full clip for changes in the face, unwanted jumps, damaged hands and motion that does not match the brief. Listen to any generated audio or added narration. A delivered video may need another attempt, and added narration should not be mistaken for guaranteed synchronized lip movement."] },
    ], cta: { label: "Plan a character video", href: "/generate" } },
  },
  {
    path: "/glossary", title: "iDream glossary: understand the controls you use",
    description: "Plain-language definitions of source images, visual identity, generation quotes and the product decisions behind an accepted media request.",
    body: { heading: "iDream glossary", intro: "These definitions explain product controls in ordinary language. Use them when you are choosing a source, reviewing a generation request or deciding how to keep a result. Each term connects to a concrete action in iDream.", sections: [
      { heading: "Inputs are different from results", paragraphs: ["A source image is the image selected for an edit or animation. Visual identity describes the stable appearance a Character should retain. A generated result is a new artifact to review; it is not proof that every requested detail or identity constraint was reproduced correctly."] },
      { heading: "A quote records an accepted request", paragraphs: ["A generation quote shows the selected route, output specification and estimated dreamcoin cost before submission. A job tracks the accepted work through processing and delivery. If a request has an uncertain result, checking its job is safer than submitting a different request accidentally."] },
    ], cta: { label: "Explore the generation controls", href: "/generate" } },
  },
  {
    path: "/glossary/source-image", title: "Source image: the starting point for an edit or clip",
    description: "Understand how a selected source image anchors an iDream edit or character animation and how to check that source before accepting a request.",
    body: { heading: "Source image", intro: "A source image is the specific image used as the starting point for a change. In an edit, it supplies the picture being modified. In image-to-video, it supplies the visible character and composition that the motion begins from.", sections: [
      { heading: "Choose the source for the actual task", paragraphs: ["Select an image whose framing and detail support the change you want. A close portrait and a full-body scene provide different information. Before submitting, confirm that the selected preview is the correct image and that you are allowed to use it for the requested operation."] },
      { heading: "Keep source and identity separate", paragraphs: ["The source is one concrete image. The Character's visual identity is the broader set of appearance facts and accepted references that should remain recognizable. Changing a source does not mean you intended to create another person, and adopting a generated image as a main image is a separate decision."] },
    ], cta: { label: "Read the source-edit guide", href: "/images/edit-a-source" } },
  },
  {
    path: "/glossary/generation-quote", title: "Generation quote: review the work before it starts",
    description: "Learn what a generation quote describes, when to review a changed request and how to check an accepted iDream job after a lost response.",
    body: { heading: "Generation quote", intro: "A generation quote is the review point before an image or video request starts. It describes the selected execution route, output settings and cost. The accepted request should match what you reviewed rather than silently adopting later changes.", sections: [
      { heading: "Recheck the quote after a meaningful change", paragraphs: ["A different source, model or output setting can change the work and its price. Review the new quote before accepting it. The price shown for one request is not a permanent promise for every future request or a guarantee of the visual result you will receive."] },
      { heading: "A missing response is not always a missing job", paragraphs: ["If the connection drops after submission, the job may already have been accepted. Check that original request in Jobs before submitting again. A processing state means work is still underway; only a delivered result and its recorded settlement show that the request has completed."] },
    ], cta: { label: "Review a generation request", href: "/generate" } },
  },
  {
    path: "/authors", title: "iDream publications and product guides",
    description: "Meet the iDream product-guide publication, explore its practical topics, and find out how to suggest a correction or an update.",
    body: { heading: "Publications and product guides", intro: "iDream publishes practical guides to creating characters, working with images and video, and understanding the controls you use. Explore the product-guide collection below to find a clear next step for your project and learn how to help keep these explanations current.", sections: [
      { heading: "Know what the guide is for", paragraphs: ["The iDream collection explains existing product controls and practical ways to review a result. A guide helps you make a choice; it does not replace the current settings, quote or delivery status in the application. Product behavior can change as new capabilities become available."] },
      { heading: "Help keep the guides current", paragraphs: ["If an instruction is unclear or a control differs from what the guide describes, contact Help Desk with the page path and the step you were trying to complete. Your feedback helps iDream review the explanation and publish a useful correction for future readers."] },
    ], cta: { label: "Read the iDream guide collection", href: "/authors/idream-guides" } },
  },
  {
    path: "/authors/idream-guides", title: "The iDream product-guide collection",
    description: "The publication label for original iDream product guides: what the collection covers, how to use it and where to report unclear instructions.",
    body: { heading: "iDream product guides", intro: "iDream product guides is the publication label for original explanations of this application's controls. Each guide connects a practical task with the choices you can make and the results you can review, helping you move from an idea to a usable character or piece of media.", sections: [
      { heading: "The scope of this collection", paragraphs: ["Image guides cover character identity, source selection and deliberate edits. Video guides explain how to plan motion and review a delivered clip. The glossary defines the inputs, quote and job states that appear while using those tools. Current availability and cost remain visible in the application."] },
      { heading: "Use a guide and suggest an update", paragraphs: ["Read each example as a starting point for your own project, then review the source and settings before submitting. iDream updates these explanations as the tools change. If a step needs a clearer explanation, send the page path and the step to Help Desk so the publication can be improved."] },
    ], cta: { label: "Browse published resources", href: "/resources-hub" } },
  },
];
