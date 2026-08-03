import { useDocument } from "@/hooks/useFirebase";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { asArray } from "@/lib/utils";
import {
  Dumbbell, Sparkles, Waves, Heart, Users, Clock, Check, ArrowRight,
  Trophy, Timer, Flame, Zap, ImageOff,
} from "lucide-react";
import { DataError } from "@/components/ui/data-error";
import PageHeroBanner from "@/components/public/PageHeroBanner";

const ICON_MAP: Record<string, React.ComponentType<any>> = {
  Dumbbell, Sparkles, Waves, Heart, Users, Trophy, Timer, Flame, Zap,
};

interface GymEquipmentItem {
  id: string;
  name: string;
  image: string;
  description: string;
  icon?: string;
}

interface GymPackage {
  id: string;
  name: string;
  price: number;
  duration: string;
  features: string[];
  popular?: boolean;
}

interface GymProgram {
  id: string;
  name: string;
  description: string;
  image?: string;
}

interface GymHoursRow {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

interface GymContent {
  about: string;
  equipment: GymEquipmentItem[];
  hours: GymHoursRow[];
  packages: GymPackage[];
  programs: GymProgram[];
  gallery: string[];
}

const EMPTY_GYM: GymContent = { about: "", equipment: [], hours: [], packages: [], programs: [], gallery: [] };

export default function GymPage() {
  const { data: gymDoc, loading, error } = useDocument("cms_content", "gym");
  const content: GymContent = {
    ...EMPTY_GYM,
    ...(((gymDoc as any)?.data) || {}),
    equipment: asArray<GymEquipmentItem>((gymDoc as any)?.data?.equipment),
    hours: asArray<GymHoursRow>((gymDoc as any)?.data?.hours),
    packages: asArray<GymPackage>((gymDoc as any)?.data?.packages),
    programs: asArray<GymProgram>((gymDoc as any)?.data?.programs),
    gallery: asArray<string>((gymDoc as any)?.data?.gallery),
  };

  return (
    <div className="min-h-screen bg-background">
      <PageHeroBanner
        docId="gym_hero"
        fallbackTitle="Fitness Center"
        fallbackSubtitle="Stay Active"
        fallbackDescription="A fully-equipped gym with modern equipment, wellness programs, and expert trainers"
        heightClass="h-80"
      />

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="container mx-auto px-4 py-16">
          <DataError message="We couldn't load the gym page. Please check your connection and try again." />
        </div>
      ) : (
        <>
          {/* About */}
          {content.about && (
            <div className="container mx-auto px-4 py-14 max-w-3xl text-center">
              <h2 className="font-serif text-3xl font-bold mb-4">Our Fitness Center</h2>
              <p className="text-muted-foreground leading-relaxed">{content.about}</p>
            </div>
          )}

          {/* Equipment & Services */}
          <div className="container mx-auto px-4 py-6">
            {content.equipment.length > 0 && (
              <>
                <h2 className="font-serif text-2xl md:text-3xl font-bold text-center mb-10">
                  Equipment &amp; Services
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-16">
                  {content.equipment.map((item) => {
                    const Icon = ICON_MAP[item.icon || ""] || Dumbbell;
                    return (
                      <Card key={item.id} className="overflow-hidden group hover:shadow-xl transition-all duration-300">
                        {item.image && (
                          <div className="h-48 overflow-hidden">
                            <img src={item.image} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                          </div>
                        )}
                        <CardContent className="p-6">
                          <div className="flex items-center gap-3 mb-3">
                            <div className="w-11 h-11 bg-primary/10 rounded-xl flex items-center justify-center">
                              <Icon className="w-5 h-5 text-primary" />
                            </div>
                            <h3 className="font-serif text-lg font-bold">{item.name}</h3>
                          </div>
                          <p className="text-muted-foreground text-sm">{item.description}</p>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Hours + quick facts */}
          {content.hours.length > 0 && (
            <div className="bg-muted/40 py-16">
              <div className="container mx-auto px-4 max-w-2xl">
                <h2 className="font-serif text-2xl md:text-3xl font-bold text-center mb-8 flex items-center justify-center gap-2">
                  <Clock className="w-6 h-6 text-primary" /> Operating Hours
                </h2>
                <Card>
                  <CardContent className="p-6 divide-y divide-border">
                    {content.hours.map((row, i) => (
                      <div key={i} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                        <span className="font-medium text-sm">{row.day}</span>
                        <span className="text-sm text-muted-foreground">
                          {row.closed ? "Closed" : `${row.open} – ${row.close}`}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* Membership Packages */}
          {content.packages.length > 0 && (
            <div className="container mx-auto px-4 py-16">
              <h2 className="font-serif text-2xl md:text-3xl font-bold text-center mb-3">Membership Packages</h2>
              <p className="text-muted-foreground text-center mb-10 max-w-xl mx-auto">
                Flexible plans for guests and members. Visit the front desk or contact us to sign up.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto items-stretch">
                {content.packages.map((pkg) => (
                  <Card
                    key={pkg.id}
                    className={`flex flex-col ${pkg.popular ? "border-primary shadow-lg ring-1 ring-primary/30" : ""}`}
                  >
                    <CardContent className="p-6 flex flex-col flex-1">
                      {pkg.popular && (
                        <span className="self-start mb-3 text-[10px] uppercase tracking-wide font-semibold bg-primary text-primary-foreground px-2.5 py-1 rounded-full">
                          Most Popular
                        </span>
                      )}
                      <h3 className="font-serif text-xl font-bold">{pkg.name}</h3>
                      <p className="text-muted-foreground text-xs mt-1">{pkg.duration}</p>
                      <p className="text-3xl font-bold mt-4">
                        ${Number(pkg.price || 0).toFixed(0)}
                      </p>
                      <ul className="mt-5 space-y-2 flex-1">
                        {(pkg.features || []).map((f, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" /> {f}
                          </li>
                        ))}
                      </ul>
                      <Link href="/contact">
                        <Button className="mt-6 w-full rounded-full" variant={pkg.popular ? "default" : "outline"}>
                          Enquire
                        </Button>
                      </Link>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Programs / personal training */}
          {content.programs.length > 0 && (
            <div className="bg-muted/40 py-16">
              <div className="container mx-auto px-4">
                <h2 className="font-serif text-2xl md:text-3xl font-bold text-center mb-10">
                  Personal Training &amp; Programs
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {content.programs.map((p) => (
                    <Card key={p.id} className="overflow-hidden">
                      {p.image && (
                        <div className="h-44 overflow-hidden">
                          <img src={p.image} alt={p.name} className="w-full h-full object-cover" />
                        </div>
                      )}
                      <CardContent className="p-6">
                        <h3 className="font-serif text-lg font-bold mb-2">{p.name}</h3>
                        <p className="text-muted-foreground text-sm">{p.description}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Gallery */}
          {content.gallery.length > 0 && (
            <div className="container mx-auto px-4 py-16">
              <h2 className="font-serif text-2xl md:text-3xl font-bold text-center mb-10">Gym Gallery</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {content.gallery.map((url, i) => (
                  <div key={i} className="aspect-square rounded-xl overflow-hidden bg-muted">
                    {url ? (
                      <img src={url} alt={`Gym photo ${i + 1}`} loading="lazy" className="w-full h-full object-cover hover:scale-105 transition-transform duration-500" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><ImageOff className="w-6 h-6 text-muted-foreground/50" /></div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {content.equipment.length === 0 && content.packages.length === 0 && content.programs.length === 0 && (
            <div className="container mx-auto px-4 py-16">
              <p className="text-center text-muted-foreground">
                Gym details are being updated — please check back soon.
              </p>
            </div>
          )}

          <div className="container mx-auto px-4 pb-16 text-center">
            <h2 className="font-serif text-3xl font-bold mb-4">Ready to Work Out?</h2>
            <p className="text-muted-foreground mb-6">Visit the gym desk during your stay, or contact us to learn more.</p>
            <div className="flex flex-wrap gap-3 justify-center">
              <Link href="/contact"><Button size="lg" variant="outline" className="rounded-full px-10">Contact Us</Button></Link>
              <Link href="/booking"><Button size="lg" className="rounded-full px-10 gap-2">Book Your Stay <ArrowRight className="w-4 h-4" /></Button></Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
